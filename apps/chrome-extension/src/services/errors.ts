import { Data } from 'effect';

export class ChromeApiError extends Data.TaggedError('ChromeApiError')<{
  readonly operation: string;
  readonly message: string;
  readonly tabId?: number;
  readonly windowId?: number;
}> {}

export class UnsupportedPageError extends Data.TaggedError('UnsupportedPageError')<{
  readonly url: string;
}> {}

export class TabNotFoundError extends Data.TaggedError('TabNotFoundError')<{
  readonly tabId: number;
}> {}

export class WindowNotFoundError extends Data.TaggedError('WindowNotFoundError')<{
  readonly windowId: number;
}> {}

export class ActionExecutionError extends Data.TaggedError('ActionExecutionError')<{
  readonly action: string;
  readonly message: string;
}> {}

export type SwitcherError =
  | ChromeApiError
  | UnsupportedPageError
  | TabNotFoundError
  | WindowNotFoundError
  | ActionExecutionError;

export const errorMessage = (error: SwitcherError): string => {
  switch (error._tag) {
    case 'TabNotFoundError':
      return 'That tab no longer exists.';
    case 'WindowNotFoundError':
      return 'That browser window no longer exists.';
    case 'UnsupportedPageError':
      return 'This page does not allow extension overlays.';
    case 'ActionExecutionError':
      return error.message;
    case 'ChromeApiError':
      return error.operation.includes('mute')
        ? 'Chrome did not allow the tab to be muted.'
        : 'Chrome could not complete that action.';
  }
};
