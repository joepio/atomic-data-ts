import { setCookieAuthentication } from './authentication.js';
import { EventManager } from './EventManager.js';
import {
  Agent,
  Datatype,
  datatypeFromUrl,
  Client,
  Resource,
  unknownSubject,
  urls,
  Commit,
  JSONADParser,
} from './index.js';
import { authenticate, fetchWebSocket, startWebsocket } from './websockets.js';

/** Function called when a resource is updated or removed */
type ResourceCallback = (resource: Resource) => void;
/** Callback called when the stores agent changes */
type AgentCallback = (agent: Agent | undefined) => void;
type ErrorCallback = (e: Error) => void;

type Fetch = typeof fetch;

export interface StoreOpts {
  /** The default store URL, where to send commits and where to create new instances */
  serverUrl?: string;
  /** Default Agent, used for signing commits. Is required for posting things. */
  agent?: Agent;
}

export enum StoreEvents {
  /**
   * Whenever `Resource.save()` is called, so only when the user of this library
   * performs a save action.
   */
  ResourceSaved = 'resource-saved',
  /** User perform a Remove action */
  ResourceRemoved = 'resource-removed',
  /**
   * User explicitly created a Resource through a conscious action, e.g. through
   * the SideBar.
   */
  ResourceManuallyCreated = 'resource-manually-created',
  /** Event that gets called whenever the stores agent changes */
  AgentChanged = 'agent-changed',
  /** Event that gets called whenever the store encounters an error */
  Error = 'error',
}

/**
 * Handlers are functions that are called when a certain event occurs.
 */
type StoreEventHandlers = {
  [StoreEvents.ResourceSaved]: ResourceCallback;
  [StoreEvents.ResourceRemoved]: ResourceCallback;
  [StoreEvents.ResourceManuallyCreated]: ResourceCallback;
  [StoreEvents.AgentChanged]: AgentCallback;
  [StoreEvents.Error]: ErrorCallback;
};

/** Returns True if the client has WebSocket support */
const supportsWebSockets = () => typeof WebSocket !== 'undefined';

/**
 * An in memory store that has a bunch of usefful methods for retrieving Atomic
 * Data Resources. It is also resposible for keeping the Resources in sync with
 * Subscribers (components that use the Resource), and for managing the current
 * Agent (User).
 */
export class Store {
  /** A list of all functions that need to be called when a certain resource is updated */
  public subscribers: Map<string, Array<ResourceCallback>>;
  private injectedFetch: Fetch;
  /**
   * The base URL of an Atomic Server. This is where to send commits, create new
   * instances, search, etc.
   */
  private serverUrl: string;
  /** All the resources of the store */
  private _resources: Map<string, Resource>;
  /** Current Agent, used for signing commits. Is required for posting things. */
  private agent?: Agent;
  /** Mapped from origin to websocket */
  private webSockets: Map<string, WebSocket>;

  private eventManager = new EventManager<StoreEvents, StoreEventHandlers>();

  private client: Client;

  public constructor(opts: StoreOpts = {}) {
    this._resources = new Map();
    this.webSockets = new Map();
    this.subscribers = new Map();
    opts.serverUrl && this.setServerUrl(opts.serverUrl);
    opts.agent && this.setAgent(opts.agent);
    this.client = new Client(this.injectedFetch);

    // We need to bind this method because it is passed down by other functions
    this.getAgent = this.getAgent.bind(this);
    this.setAgent = this.setAgent.bind(this);
  }

  /** All the resources of the store */
  public get resources(): Map<string, Resource> {
    return this._resources;
  }

  /** Inject a custom fetch implementation to use when fetching resources over http */
  public injectFetch(fetchOverride: Fetch) {
    this.injectedFetch = fetchOverride;
    this.client.setFetch(fetchOverride);
  }

  public addResources(...resources: Resource[]): void {
    for (const resource of resources) {
      this.addResource(resource);
    }
  }

  /**
   * @deprecated Will be marked private in the future, please use `addResources`
   *
   * Adds a Resource to the store and notifies subscribers. Replaces existing
   * resources, unless this new resource is explicitly incomplete.
   */
  public addResource(resource: Resource): void {
    // Incomplete resources may miss some properties
    if (resource.get(urls.properties.incomplete)) {
      // If there is a resource with the same subject, we won't overwrite it with an incomplete one
      const existing = this.resources.get(resource.getSubject());

      if (existing && !existing.loading) {
        return;
      }
    }

    this.resources.set(resource.getSubject(), resource);

    this.notify(resource.clone());
  }

  /** Checks if a subject is free to use */
  public async checkSubjectTaken(subject: string): Promise<boolean> {
    const r = await this.getResourceAsync(subject);

    if (r.isReady()) {
      return true;
    }

    return false;
  }

  /**
   * Checks is a set of URL parts can be combined into an available subject.
   * Will retry until it works.
   */
  public async buildUniqueSubjectFromParts(
    ...parts: string[]
  ): Promise<string> {
    const path = parts.join('/');

    return this.findAvailableSubject(path);
  }

  /** Creates a random URL. Add a classnme (e.g. 'persons') to make a nicer name */
  public createSubject(className?: string): string {
    const random = this.randomPart();
    className = className ? className : 'things';

    return `${this.getServerUrl()}/${className}/${random}`;
  }

  /**
   * Always fetches resource from the server then adds it to the store.
   */
  public async fetchResourceFromServer(
    /** The resource URL to be fetched */
    subject: string,
    opts: {
      /**
       * Fetch it from the `/path` endpoint of your server URL. This effectively
       * is a proxy / cache.
       */
      fromProxy?: boolean;
      /** Overwrites the existing resource and sets it to loading. */
      setLoading?: boolean;
      /** Do not use WebSockets, use HTTP(S) */
      noWebSocket?: boolean;
    } = {},
  ): Promise<Resource> {
    if (opts.setLoading) {
      const newR = new Resource(subject);
      newR.loading = true;
      this.addResources(newR);
    }

    // Use WebSocket if available, else use HTTP(S)
    const ws = this.getWebSocketForSubject(subject);

    if (
      !opts.fromProxy &&
      !opts.noWebSocket &&
      supportsWebSockets() &&
      ws?.readyState === WebSocket.OPEN
    ) {
      await fetchWebSocket(ws, subject);
    } else {
      const signInfo = this.agent
        ? { agent: this.agent, serverURL: this.getServerUrl() }
        : undefined;

      const { createdResources } = await this.client.fetchResourceHTTP(
        subject,
        {
          from: opts.fromProxy ? this.getServerUrl() : undefined,
          signInfo,
        },
      );

      this.addResources(...createdResources);
    }

    return this.resources.get(subject)!;
  }

  public getAllSubjects(): string[] {
    return Array.from(this.resources.keys());
  }

  /** Returns the WebSocket for the current Server URL */
  public getDefaultWebSocket(): WebSocket | undefined {
    return this.webSockets.get(this.getServerUrl());
  }

  /** Opens a Websocket for some subject URL, or returns the existing one. */
  public getWebSocketForSubject(subject: string): WebSocket | undefined {
    const url = new URL(subject);
    const found = this.webSockets.get(url.origin);

    if (found) {
      return found;
    } else {
      if (typeof window !== 'undefined') {
        this.webSockets.set(url.origin, startWebsocket(url.origin, this));
      }
    }

    return;
  }

  /** Returns the base URL of the companion server */
  public getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * Returns the Currently set Agent, returns null if there is none. Make sure
   * to first run `store.setAgent()`.
   */
  public getAgent(): Agent | undefined {
    return this.agent ?? undefined;
  }

  /**
   * Gets a resource by URL. Fetches and parses it if it's not available in the
   * store. Instantly returns an empty loading resource, while the fetching is
   * done in the background . If the subject is undefined, an empty non-saved
   * resource will be returned.
   */
  public getResourceLoading(
    subject: string = unknownSubject,
    opts: FetchOpts = {},
  ): Resource {
    // This is needed because it can happen that the useResource react hook is called while there is no subject passed.
    if (subject === unknownSubject || subject === null) {
      const newR = new Resource(unknownSubject, opts.newResource);

      return newR;
    }

    const found = this.resources.get(subject);

    if (!found) {
      const newR = new Resource(subject, opts.newResource);
      newR.loading = true;
      this.addResources(newR);

      if (!opts.newResource) {
        this.fetchResourceFromServer(subject, opts);
      }

      return newR;
    } else if (!opts.allowIncomplete && found.loading === false) {
      // In many cases, a user will always need a complete resource.
      // This checks if the resource is incomplete and fetches it if it is.
      if (found.get(urls.properties.incomplete)) {
        found.loading = true;
        this.addResources(found);
        this.fetchResourceFromServer(subject, opts);
      }
    }

    return found;
  }

  /**
   * Gets a resource by URL. Fetches and parses it if it's not available in the
   * store. Not recommended to use this for rendering, because it might cause
   * resources to be fetched multiple times.
   */
  public async getResourceAsync(subject: string): Promise<Resource> {
    const found = this.resources.get(subject);

    if (found) {
      return found;
    }

    return this.fetchResourceFromServer(subject);
  }

  /** Gets a property by URL. */
  public async getProperty(subject: string): Promise<Property> {
    // This leads to multiple fetches!
    const resource = await this.getResourceAsync(subject);

    if (resource === undefined) {
      throw Error(`Property ${subject} is not found`);
    }

    if (resource.error) {
      throw Error(`Property ${subject} cannot be loaded: ${resource.error}`);
    }

    const prop = new Property();
    const datatypeUrl = resource.get(urls.properties.datatype);

    if (datatypeUrl === undefined) {
      throw Error(
        `Property ${subject} has no datatype: ${resource.getPropVals()}`,
      );
    }

    const shortname = resource.get(urls.properties.shortname);

    if (shortname === undefined) {
      throw Error(
        `Property ${subject} has no shortname: ${resource.getPropVals()}`,
      );
    }

    const description = resource.get(urls.properties.description);

    if (description === undefined) {
      throw Error(
        `Property ${subject} has no description: ${resource.getPropVals()}`,
      );
    }

    const classTypeURL = resource.get(urls.properties.classType)?.toString();
    prop.classType = classTypeURL;
    prop.shortname = shortname.toString();
    prop.description = description.toString();
    prop.datatype = datatypeFromUrl(datatypeUrl.toString());

    return prop;
  }

  /**
   * This is called when Errors occur in some of the library functions. Set your
   * errorhandler function to `store.errorHandler`.
   */
  public notifyError(e: Error | string): void {
    const error = e instanceof Error ? e : new Error(e);

    if (this.eventManager.hasSubscriptions(StoreEvents.Error)) {
      this.eventManager.emit(StoreEvents.Error, error);
    } else {
      throw error;
    }
  }

  /**
   * If the store does not have an active internet connection, will return
   * false. This may affect some functionality. For example, some checks will
   * not be performed client side when offline.
   */
  public isOffline(): boolean {
    // If we are in a node/server environment assume we are online.
    if (typeof window === 'undefined') {
      return false;
    }

    return !window?.navigator?.onLine;
  }

  /** Let's subscribers know that a resource has been changed. Time to update your views! */
  public async notify(resource: Resource): Promise<void> {
    const subject = resource.getSubject();
    const callbacks = this.subscribers.get(subject);

    if (callbacks === undefined) {
      return;
    }

    Promise.allSettled(callbacks.map(async cb => cb(resource)));
  }

  public notifyResourceSaved(resource: Resource): void {
    this.eventManager.emit(StoreEvents.ResourceSaved, resource);
  }

  public notifyResourceManuallyCreated(resource: Resource): void {
    this.eventManager.emit(StoreEvents.ResourceManuallyCreated, resource);
  }

  /** Parses the HTML document for `JSON-AD` data in <meta> tags, adds it to the store */
  public parseMetaTags(): void {
    const metaTags = document.querySelectorAll(
      'meta[property="json-ad-initial"]',
    );
    const parser = new JSONADParser();

    metaTags.forEach(tag => {
      const content = tag.getAttribute('content');

      if (content === null) {
        return;
      }

      // convert base64 content to JSON
      const json = JSON.parse(atob(content));

      const [_, resources] = parser.parseObject(json);
      this.addResources(...resources);
    });
  }

  /** Removes (destroys / deletes) resource from this store */
  public removeResource(subject: string): void {
    const resource = this.resources.get(subject);
    this.resources.delete(subject);
    resource && this.eventManager.emit(StoreEvents.ResourceRemoved, resource);
  }

  /**
   * Changes the Subject of a Resource. Checks if the new name is already taken,
   * errors if so.
   */
  public async renameSubject(
    oldSubject: string,
    newSubject: string,
  ): Promise<void> {
    Client.tryValidSubject(newSubject);
    const old = this.resources.get(oldSubject);

    if (old === undefined) {
      throw Error(`Old subject does not exist in store: ${oldSubject}`);
    }

    if (await this.checkSubjectTaken(newSubject)) {
      throw Error(`New subject name is already taken: ${newSubject}`);
    }

    old.setSubject(newSubject);
    this.resources.set(newSubject, old);
    this.removeResource(oldSubject);
  }

  /**
   * Sets the current Agent, used for signing commits. Authenticates all open
   * websockets, and retries previously failed fetches.
   *
   * Warning: doing this stores the Private Key of the Agent in memory. This
   * might have security implications for your application.
   */
  public setAgent(agent: Agent | undefined): void {
    this.agent = agent;

    if (agent) {
      setCookieAuthentication(this.serverUrl, agent);

      this.webSockets.forEach(ws => {
        ws.readyState === ws.OPEN && authenticate(ws, this);
      });

      this.resources.forEach(r => {
        if (r.isUnauthorized()) {
          this.fetchResourceFromServer(r.getSubject());
        }
      });
    }

    this.eventManager.emit(StoreEvents.AgentChanged, agent);
  }

  /** Sets the Server base URL, without the trailing slash. */
  public setServerUrl(url: string): void {
    Client.tryValidSubject(url);

    if (url.substring(-1) === '/') {
      throw Error('baseUrl should not have a trailing slash');
    }

    this.serverUrl = url;
    // TODO This is not the right place
    supportsWebSockets() && this.openWebSocket(url);
  }

  /** Opens a WebSocket for this Atomic Server URL */
  public openWebSocket(url: string) {
    // Check if we're running in a webbrowser
    if (supportsWebSockets()) {
      if (this.webSockets.has(url)) {
        return;
      }

      this.webSockets.set(url, startWebsocket(url, this));
    } else {
      console.warn('WebSockets not supported, no window available');
    }
  }

  /**
   * Registers a callback for when the a resource is updated. When you call
   * this, you should probably also call .unsubscribe some time later.
   */
  // TODO: consider subscribing to properties, maybe add a second subscribe function, use that in useValue
  public subscribe(subject: string, callback: ResourceCallback): void {
    if (subject === undefined) {
      throw Error('Cannot subscribe to undefined subject');
    }

    let callbackArray = this.subscribers.get(subject);

    if (callbackArray === undefined) {
      // Only subscribe once
      this.subscribeWebSocket(subject);
      callbackArray = [];
    }

    callbackArray.push(callback);
    this.subscribers.set(subject, callbackArray);
  }

  public subscribeWebSocket(subject: string): void {
    if (subject === unknownSubject) {
      return;
    }

    // TODO: check if there is a websocket for this server URL or not
    try {
      const ws = this.getWebSocketForSubject(subject);

      // Only subscribe if there's a websocket. When it's opened, all subject will be iterated and subscribed
      if (ws?.readyState === 1) {
        ws?.send(`SUBSCRIBE ${subject}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  public unSubscribeWebSocket(subject: string): void {
    if (subject === unknownSubject) {
      return;
    }

    try {
      this.getDefaultWebSocket()?.send(`UNSUBSCRIBE ${subject}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  /** Unregisters the callback (see `subscribe()`) */
  public unsubscribe(subject: string, callback: ResourceCallback): void {
    if (subject === undefined) {
      return;
    }

    let callbackArray = this.subscribers.get(subject);

    if (callbackArray) {
      // Remove the function from the callBackArray
      callbackArray = callbackArray?.filter(item => item !== callback);
      this.subscribers.set(subject, callbackArray);
    }
  }

  public on<T extends StoreEvents>(event: T, callback: StoreEventHandlers[T]) {
    return this.eventManager.register(event, callback);
  }

  public async uploadFiles(files: File[], parent: string): Promise<string[]> {
    const agent = this.getAgent();

    if (!agent) {
      throw Error('No agent set, cannot upload files');
    }

    const resources = await this.client.uploadFiles(
      files,
      this.getServerUrl(),
      agent,
      parent,
    );

    this.addResources(...resources);

    return resources.map(r => r.getSubject());
  }

  public async postCommit(commit: Commit, endpoint: string): Promise<Commit> {
    return this.client.postCommit(commit, endpoint);
  }

  private randomPart(): string {
    return Math.random().toString(36).substring(2);
  }

  private async findAvailableSubject(
    path: string,
    firstTry = true,
  ): Promise<string> {
    let url = `${this.getServerUrl()}/${path}`;

    if (!firstTry) {
      const randomPart = this.randomPart();
      url += `-${randomPart}`;
    }

    const taken = await this.checkSubjectTaken(url);

    if (taken) {
      return this.findAvailableSubject(path, false);
    }

    return url;
  }
}

/**
 * A Property represents a relationship between a Subject and its Value.
 * https://atomicdata.dev/classes/Property
 */
export class Property {
  public subject: string;
  /** https://atomicdata.dev/properties/datatype */
  public datatype: Datatype;
  /** https://atomicdata.dev/properties/shortname */
  public shortname: string;
  /** https://atomicdata.dev/properties/description */
  public description: string;
  /** https://atomicdata.dev/properties/classType */
  public classType?: string;
  /** If the Property cannot be found or parsed, this will contain the error */
  public error?: Error;
  /** https://atomicdata.dev/properties/isDynamic */
  public isDynamic?: boolean;
  /** When the Property is still awaiting a server response */
  public loading?: boolean;
}

export interface FetchOpts {
  /**
   * If this is true, incomplete resources will not be automatically fetched.
   * Incomplete resources are faster to process server-side, but they need to be
   * fetched again when all properties are needed.
   */
  allowIncomplete?: boolean;
  /** Do not fetch over WebSockets, always fetch over HTTP(S) */
  noWebSocket?: boolean;
  /**
   * If true, will not send a request to a server - it will simply create a new
   * local resource.
   */
  newResource?: boolean;
}
