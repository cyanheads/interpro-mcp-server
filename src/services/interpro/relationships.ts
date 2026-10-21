/**
 * @fileoverview Deterministic, whole-record slices of a clan relationship graph.
 * @module services/interpro/relationships
 */
import { z } from '@cyanheads/mcp-ts-core';
import { compareText, cursorScope } from './cursors.js';
import { JsonValueSchema } from './schemas.js';

type JsonValue = z.infer<typeof JsonValueSchema>;

/** The graph InterPro attaches to set metadata: node and link records plus any additional fields. */
export const RelationshipGraphSchema = z
  .object({ nodes: z.array(JsonValueSchema), links: z.array(JsonValueSchema) })
  .catchall(JsonValueSchema)
  .nullable()
  .optional();
/** A relationship graph as supplied, or null/absent when InterPro supplied none. */
type RelationshipGraph = z.infer<typeof RelationshipGraphSchema>;

const field = (record: JsonValue, key: string): string => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

/** Sort by the named string fields in turn; canonical JSON breaks any remaining tie. */
function ordered(records: readonly JsonValue[], keys: readonly string[]): JsonValue[] {
  return records.toSorted((a, b) => {
    for (const key of keys) {
      const difference = compareText(field(a, key), field(b, key));
      if (difference) return difference;
    }
    return compareText(cursorScope(a), cursorScope(b));
  });
}

/**
 * Order nodes by accession and links by source, target, and method, so an offset addresses the
 * same record on every call whatever order the upstream arrays arrive in.
 */
export function orderRelationships(graph: RelationshipGraph): RelationshipGraph {
  return (
    graph && {
      ...graph,
      nodes: ordered(graph.nodes, ['accession']),
      links: ordered(graph.links, ['source', 'target', 'method']),
    }
  );
}

/**
 * The `count` whole records starting at `offset` in the sequence of every node followed by every
 * link, as a graph of the upstream shape, with the page block that locates it.
 */
export function sliceRelationships(graph: RelationshipGraph, offset: number, count: number) {
  const nodes = graph?.nodes ?? [];
  const links = graph?.links ?? [];
  const total = nodes.length + links.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + count, total);
  const slice = {
    nodes: nodes.slice(Math.min(start, nodes.length), Math.min(end, nodes.length)),
    links: links.slice(Math.max(0, start - nodes.length), Math.max(0, end - nodes.length)),
  };
  const hasMore = end < total;
  return {
    relationships: graph && { ...graph, ...slice },
    page: {
      totalNodes: nodes.length,
      totalLinks: links.length,
      offset,
      returnedNodes: slice.nodes.length,
      returnedLinks: slice.links.length,
      hasMore,
      ...(hasMore ? { nextOffset: end } : {}),
    },
  };
}
