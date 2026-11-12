// The server's door to the external-content fence: `@dojo/shared` holds the one definition
// (`fenceExternal` is the only producer of the markers, `unfenceExternal` restores the text for people).

export {
  fenceExternal, unfenceExternal, defangExternalMarkers, EXTERNAL_KINDS, type ExternalKind,
  outsideSpan, fenceMarkedSpan, stripOutsideMarks, fenceRanges, fenceHead, fenceEnd, newFenceCode, type FenceRange,
  fenceAttachment, attachmentBrackets,
} from '@dojo/shared';
