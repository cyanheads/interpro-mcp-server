/**
 * @fileoverview Smoke coverage for every definition shipped by the scaffold.
 * @module tests/smoke/definitions.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { echoTool } from '@/mcp-server/tools/definitions/echo.tool.js';

describe('scaffold definition smoke test', () => {
  it('executes the shipped standard echo tool', async () => {
    // `echoTool` declares an error contract, so its handler wants a context
    // typed against it — passing `errors` narrows what `createMockContext` returns.
    const ctx = createMockContext({ errors: echoTool.errors });
    const toolResult = await echoTool.handler(echoTool.input.parse({ message: 'smoke' }), ctx);

    expect(toolResult).toEqual({ message: 'smoke' });
  });
});
