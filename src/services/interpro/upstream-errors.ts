/**
 * @fileoverview Error contracts for upstream failures the service raises identically for every tool.
 * @module services/interpro/upstream-errors
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/** Declared upstream failures every tool shares; spread after `upstream_shape_invalid`. */
export const UPSTREAM_ERRORS = [
  {
    reason: 'upstream_response_too_large',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'An upstream response exceeds 4 MiB.',
    retryable: false,
    recovery:
      'Retry list tools with a smaller limit, or retrieve individual members with interpro_get_entry instead of a large clan.',
    thrownBy: 'service',
  },
  {
    reason: 'upstream_rejected',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'InterPro returns an unhandled redirect or client rejection.',
    retryable: false,
    recovery:
      'Retry the same tool later; call interpro_list_reference with topic release to check upstream availability.',
    thrownBy: 'service',
  },
  {
    reason: 'upstream_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'InterPro has a network or server failure; HTTP 501 is not retryable.',
    retryable: true,
    recovery:
      'Retry the same tool later; call interpro_list_reference with topic release to check upstream availability.',
    thrownBy: 'service',
  },
  {
    reason: 'upstream_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'InterPro returns HTTP 408/504 or an attempt exceeds its deadline.',
    retryable: true,
    recovery:
      'Retry with a smaller limit where available, then repeat the same tool after waiting.',
    thrownBy: 'service',
  },
  {
    reason: 'upstream_rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: 'InterPro returns HTTP 429.',
    retryable: true,
    recovery:
      'Wait for retryAfter when supplied, then repeat the same tool with fewer concurrent calls.',
    thrownBy: 'service',
  },
] as const;
