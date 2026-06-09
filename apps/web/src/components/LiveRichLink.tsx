// Wraps the static <RichLink> primitive with cache + click routing:
//   - Subscribes to the rich-link cache via useRichLinkData (read-only —
//     it does NOT trigger a fetch; hover handlers own the fetch lifecycle).
//   - When the cache says `not-found`, flips the pill to broken state
//     (Section 1.5.8).
//   - On click, opens the right Shell-level modal / switches tabs based on
//     the pill's kind (Section 1.5.6).
//
// Imported wherever rich-links render: chat UserBubble + AssistantBubble
// (via the react-markdown anchor renderer).

import type { ReactNode } from 'react';

import { RichLink } from '@/components/RichLink';
import { useRichLinkData } from '@/hooks/use-rich-link-data';
import type { RichLinkKind } from '@/lib/parse-chat-text';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';
import { useAttachmentLightbox } from '@/store/attachment-lightbox';
import { useChatWorkItemModal } from '@/store/chat-work-item-modal';
import {
  scheduleRichLinkHide,
  scheduleRichLinkShow,
} from '@/store/rich-link-preview';
import { useViewingFile } from '@/store/viewing-file';

interface LiveRichLinkProps {
  kind: RichLinkKind;
  ref: string;
  text: string;
  url: string;
  projectId: string;
  children?: ReactNode;
}

export function LiveRichLink({
  kind,
  ref: entityRef,
  text,
  url,
  projectId,
  children,
}: LiveRichLinkProps) {
  const { status } = useRichLinkData(projectId, url);
  const broken = status === 'not-found';
  const handleActivate = () => {
    if (kind === 'work-item') {
      useChatWorkItemModal.getState().open(entityRef);
      return;
    }
    if (kind === 'attachment') {
      useAttachmentLightbox.getState().open(entityRef);
      return;
    }
    if (kind === 'file') {
      const slug = useActiveProject.getState().activeSlug;
      if (slug) {
        useViewingFile.getState().setViewing(slug, entityRef);
        useActiveCenterTab.getState().setTab('files');
      }
      return;
    }
    if (kind === 'workflow') {
      // pc-pty-chat-358.2: navigate to the Workflows tab. The tab renders the
      // full list and the user can then click into the specific workflow.
      useActiveCenterTab.getState().setTab('workflows');
      return;
    }
    // inbox — Section 7
  };
  return (
    <RichLink
      kind={kind}
      ref={entityRef}
      text={text}
      url={url}
      broken={broken}
      onActivate={handleActivate}
      onHoverStart={(anchor) => scheduleRichLinkShow(anchor, url, projectId)}
      onHoverEnd={scheduleRichLinkHide}
    >
      {children}
    </RichLink>
  );
}
