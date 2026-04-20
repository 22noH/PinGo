// providers/git/branch-errors.ts — BranchCreateResult.errorCode 분류 (Phase 4 B4)
import type { BranchCreateResult } from '../../../shared/types';

type HttpLike = { response?: { status?: number }; code?: string; message?: string };

export function classifyBranchCreateError(err: unknown): Pick<BranchCreateResult, 'errorCode' | 'error'> {
  const e = (err ?? {}) as HttpLike;
  const status = typeof e.response?.status === 'number' ? e.response.status : undefined;
  const code = typeof e.code === 'string' ? e.code : '';
  const msg = typeof e.message === 'string' ? e.message : String(err);

  if (status === 409 || status === 422) return { errorCode: 'conflict', error: 'conflict' };
  if (status === 403) return { errorCode: 'forbidden', error: 'forbidden' };
  if (status === 404) return { errorCode: 'not_found', error: 'not_found' };

  const networkCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);
  if (networkCodes.has(code) || /network|timeout/i.test(msg)) {
    return { errorCode: 'network', error: 'network' };
  }
  return { errorCode: 'unknown', error: 'unknown' };
}
