import { z } from 'zod/v4'
import { clampTimeout, defineTool, errorResult, textResult } from './framework'
import type { RemoteObject } from '@browseros/cdp-protocol/domains/runtime'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 60_000

const DESCRIPTION = `Execute JavaScript in the target tab's page context, behaving like the Chrome DevTools console. 
It supports console helpers ($, $$, copy, etc.) and correctly deeply serializes objects, arrays, DOM nodes, Maps, Sets, and circular references.
It also captures any console.log/warn/error/info/table output produced during execution and returns it alongside the result.
Use this for advanced debugging and complex page queries where evaluate/read/grep fall short.`

export const console_execute = defineTool({
  name: 'console_execute',
  description: DESCRIPTION,
  input: z
    .object({
      tabId: z.number().int().optional().describe('Tab/Page id to run the script in. Omitting defaults to active tab if supported, otherwise fails.'),
      expression: z
        .string()
        .describe('JavaScript expression to evaluate in the console.'),
      awaitPromise: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to await the promise if the expression evaluates to a Promise.'),
      timeoutMs: z
        .number()
        .optional()
        .describe('Max evaluation time in ms. Hard cap: 60000 (larger values are clamped to it).'),
    })
    .strict(),
  annotations: {
    title: 'Execute JS in Console',
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    let targetPageId = args.tabId;
    if (targetPageId === undefined) {
       // Find an active page using pages manager
       const pages = ctx.session.pages as any;
       const activeTabs = pages.getTabs ? pages.getTabs() : [];
       if (activeTabs.length > 0) {
         targetPageId = activeTabs[0];
       } else {
         return errorResult('console_execute: tabId is required or no active tabs found.');
       }
    }

    let pageSession;
    try {
      pageSession = (await ctx.session.pages.getSession(targetPageId)).session;
    } catch (e) {
      return errorResult(`console_execute: could not get session for tabId ${targetPageId}`);
    }

    const timeout = clampTimeout(args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

    await pageSession.Runtime.enable().catch(() => {});

    const rawLogs: any[] = [];
    const off = pageSession.Runtime.on('consoleAPICalled', (params) => {
      rawLogs.push(params);
    });

    let evaluateResult;
    try {
      evaluateResult = await pageSession.Runtime.evaluate({
        expression: args.expression,
        includeCommandLineAPI: true,
        replMode: true,
        awaitPromise: args.awaitPromise !== false,
        timeout,
      });
    } catch (e: any) {
      off();
      return errorResult(`console_execute: CDP evaluate threw: ${e?.message || String(e)}`);
    }

    off();

    // Helper to deeply serialize a list of RemoteObjects
    async function serializeRemoteObjects(remoteObjects: any[]): Promise<any[]> {
      if (!remoteObjects || remoteObjects.length === 0) return [];

      const callArgs = remoteObjects.map((a: any) => {
        if (a.objectId) return { objectId: a.objectId };
        if (a.unserializableValue !== undefined) return { unserializableValue: a.unserializableValue };
        return { value: a.value };
      });

      const anchor = callArgs.find(a => a.objectId);
      if (!anchor) {
        // All primitives
        return remoteObjects.map((a: any) => {
          if (a.unserializableValue !== undefined) return { __type: a.unserializableValue };
          if (a.value === undefined && a.type === 'undefined') return { __type: 'undefined' };
          return a.value;
        });
      }

      const fnString = `function(...args) {
        const seen = new WeakSet();
        function serialize(val) {
          if (val === null) return null;
          if (val === undefined) return { __type: "undefined" };
          if (typeof val === "number" && isNaN(val)) return { __type: "NaN" };
          if (typeof val === "number" && !isFinite(val)) return { __type: val > 0 ? "Infinity" : "-Infinity" };
          if (typeof val === "bigint") return { __type: "bigint", value: val.toString() };
          if (typeof val === "function") return { __type: "function", name: val.name || "(anonymous)" };
          if (typeof val === "symbol") return { __type: "symbol", value: val.toString() };
          if (typeof val !== "object") return val;

          if (seen.has(val)) {
            return "[Circular]";
          }
          seen.add(val);

          try {
            if (val instanceof Node) {
              let desc = val.nodeName.toLowerCase();
              if (val.id) desc += "#" + val.id;
              if (val.className && typeof val.className === "string") {
                desc += "." + val.className.trim().split(/\\s+/).join(".");
              }
              return { __type: "node", description: desc };
            }
          } catch(e) {}

          try {
            if (val instanceof Map) {
              const entries = Array.from(val.entries()).map(([k, v]) => [serialize(k), serialize(v)]);
              return { __type: "map", entries };
            }
          } catch(e) {}

          try {
            if (val instanceof Set) {
              const values = Array.from(val.values()).map(v => serialize(v));
              return { __type: "set", values };
            }
          } catch(e) {}

          try {
            if (val instanceof Error) {
              return { __type: "error", name: val.name, message: val.message, stack: val.stack };
            }
          } catch(e) {}

          if (Array.isArray(val)) {
            return val.map(v => serialize(v));
          }

          const res = {};
          try {
            for (const key of Object.keys(val)) {
              try {
                res[key] = serialize(val[key]);
              } catch (e) {
                res[key] = "[Exception reading property]";
              }
            }
          } catch(e) {}
          return res;
        }
        return args.map(a => serialize(a));
      }`;

      try {
        const res = await pageSession.Runtime.callFunctionOn({
          objectId: anchor.objectId,
          functionDeclaration: fnString,
          arguments: callArgs,
          returnByValue: true
        });
        
        if (res.exceptionDetails) {
           return remoteObjects.map(() => '[Exception during serialization: ' + res.exceptionDetails.exception?.description + ']');
        }
        return res.result.value || [];
      } catch (err) {
        return remoteObjects.map(() => '[Serialization CDP Error]');
      }
    }

    // Process logs
    const logs = [];
    for (const log of rawLogs) {
      if (['log', 'warn', 'error', 'info', 'table', 'dir'].includes(log.type)) {
         const serializedArgs = await serializeRemoteObjects(log.args || []);
         logs.push({
           type: log.type,
           args: serializedArgs
         });
      }
    }

    // Process result
    let finalResult: any = null;
    let exception: any = undefined;

    if (evaluateResult.exceptionDetails) {
       const ex = evaluateResult.exceptionDetails.exception;
       if (ex) {
         const serializedEx = await serializeRemoteObjects([ex]);
         exception = serializedEx[0];
       } else {
         exception = { text: evaluateResult.exceptionDetails.text };
       }
    } else {
       const res = await serializeRemoteObjects([evaluateResult.result]);
       finalResult = res[0];
    }

    const payload = {
      result: finalResult,
      type: evaluateResult.result?.type || 'undefined',
      logs,
      ...(exception && { exception })
    };

    return textResult(JSON.stringify(payload, null, 2), payload);
  },
})
