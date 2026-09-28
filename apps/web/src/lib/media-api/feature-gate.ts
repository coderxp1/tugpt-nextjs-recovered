// Media API feature gate.
// Checks the `media_generation` flag via the is_feature_enabled RPC
// (service-role client), mirroring the draft API's feature-gate.

import type { TypedSupabaseClient } from '@tugpt/database';

export interface FeatureGateResult {
  allowed: boolean;
  statusCode: number;
  message: string;
}

const FLAG_KEY = 'media_generation';

/**
 * Check whether media generation is enabled for the given organization.
 * Uses a service-role Supabase client to call the is_feature_enabled RPC.
 * Fail-closed: any RPC error denies access.
 */
export async function checkMediaFeatureGate(
  adminClient: TypedSupabaseClient,
  organizationId: string
): Promise<FeatureGateResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (adminClient as any).rpc('is_feature_enabled', {
    p_organization_id: organizationId,
    p_flag_key: FLAG_KEY,
  });

  if (error) {
    return {
      allowed: false,
      statusCode: 503,
      message: 'Feature unavailable',
    };
  }

  if (!data) {
    return {
      allowed: false,
      statusCode: 503,
      message: 'Feature unavailable',
    };
  }

  return {
    allowed: true,
    statusCode: 200,
    message: '',
  };
}
