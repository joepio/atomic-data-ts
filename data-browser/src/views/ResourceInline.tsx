import React from 'react';
import styled from 'styled-components';
import { useString, useResource, useTitle } from '@tomic/react';
import { urls } from '@tomic/lib';
import AtomicLink from '../components/Link';

type Props = {
  subject: string;
  untabbable?: boolean;
};

/** Renders a Resource in a small, inline link. */
function ResourceInline({ subject, untabbable }: Props): JSX.Element {
  const [resource] = useResource(subject);
  const title = useTitle(resource);
  const [description] = useString(resource, urls.properties.description);

  if (resource.loading) {
    return (
      <span about={subject} title={`${subject} is loading..`}>
        ...
      </span>
    );
  }
  if (resource.error) {
    return (
      <AtomicLink subject={subject} untabbable={untabbable}>
        <ErrorLook about={subject} title={resource.getError().message}>
          {title}
        </ErrorLook>
      </AtomicLink>
    );
  }

  return (
    <AtomicLink subject={subject} untabbable={untabbable}>
      <span title={description ? description : null}>{title}</span>
    </AtomicLink>
  );
}

export const ErrorLook = styled.span`
  color: ${props => props.theme.colors.alert};
  line-height: 1em;
  font-family: monospace;
`;

export default ResourceInline;
