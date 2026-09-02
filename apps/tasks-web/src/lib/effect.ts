import { Effect, Fiber, ManagedRuntime } from "effect";
import { useCallback, useEffect, useEffectEvent, useState } from "react";

import { ApiClient, ApiClientLive, type ApiError } from "@/lib/api";

export const apiRuntime = ManagedRuntime.make(ApiClientLive);

export type AsyncState<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "success"; readonly data: A }
  | { readonly _tag: "error"; readonly error: ApiError };

export function useEffectQuery<A>(
  makeEffect: () => Effect.Effect<A, ApiError, ApiClient>,
  key: string,
) {
  const [state, setState] = useState<AsyncState<A>>({ _tag: "loading" });
  const [version, setVersion] = useState(0);
  const execute = useEffectEvent(makeEffect);
  const requestKey = `${key}:${version}`;
  const refresh = useCallback(() => {
    setState({ _tag: "loading" });
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    const fiber = apiRuntime.runFork(
      execute().pipe(
        Effect.annotateLogs("requestKey", requestKey),
        Effect.match({
          onFailure: (error) => setState({ _tag: "error", error }),
          onSuccess: (data) => setState({ _tag: "success", data }),
        }),
      ),
    );
    return () => {
      apiRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [requestKey]);

  return { state, refresh } as const;
}

export function runMutation<A>(
  effect: Effect.Effect<A, ApiError, ApiClient>,
  handlers: {
    readonly onSuccess: (value: A) => void;
    readonly onError: (error: ApiError) => void;
  },
) {
  return apiRuntime.runFork(
    effect.pipe(Effect.match({ onFailure: handlers.onError, onSuccess: handlers.onSuccess })),
  );
}
