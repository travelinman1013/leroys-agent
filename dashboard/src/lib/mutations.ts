/**
 * Standard mutation wrapper for the dashboard.
 *
 * Provides a default-to-toast pattern: pass `successMessage` and any
 * thrown error becomes an error toast automatically. Returns a tuned
 * TanStack mutation, including invalidation hooks.
 */

import { useMutation, useQueryClient, type MutationFunction } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { useNotify } from "./notifications";

export interface UseApiMutationOptions<TData, TVariables> {
  mutationFn: MutationFunction<TData, TVariables>;
  /** Query keys to invalidate on success. */
  invalidate?: QueryKey[];
  successMessage?: string | ((data: TData, vars: TVariables) => string | null);
  errorMessage?: string | ((err: Error, vars: TVariables) => string);
  onSuccess?: (data: TData, vars: TVariables) => void;
  onError?: (err: Error, vars: TVariables) => void;
}

export function useApiMutation<TData = unknown, TVariables = void>(
  opts: UseApiMutationOptions<TData, TVariables>,
) {
  const queryClient = useQueryClient();
  const notify = useNotify();

  return useMutation<TData, Error, TVariables>({
    mutationFn: opts.mutationFn,
    onSuccess: (data, vars) => {
      if (opts.invalidate) {
        for (const key of opts.invalidate) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
      if (opts.successMessage) {
        const msg =
          typeof opts.successMessage === "function"
            ? opts.successMessage(data, vars)
            : opts.successMessage;
        if (msg) notify.success(msg);
      }
      opts.onSuccess?.(data, vars);
    },
    onError: (err, vars) => {
      const msg =
        typeof opts.errorMessage === "function"
          ? opts.errorMessage(err, vars)
          : opts.errorMessage ?? err.message ?? "Request failed";
      notify.error(msg);
      opts.onError?.(err, vars);
    },
  });
}
