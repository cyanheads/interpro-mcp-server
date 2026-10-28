/**
 * @fileoverview Server-specific environment configuration, parsed lazily after `.env` loads.
 * @module config/server-config
 */
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  scanEmail: z
    .email()
    .optional()
    .describe(
      'Contact address the EBI Job Dispatcher requires for InterProScan submissions; unset disables submission only.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let config: ServerConfig | undefined;

/** Parse once on first read; call from `setup()` so an invalid value fails startup. */
export function getServerConfig(): ServerConfig {
  config ??= parseEnvConfig(ServerConfigSchema, { scanEmail: 'INTERPRO_SCAN_EMAIL' });
  return config;
}
