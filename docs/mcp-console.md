# Console MCP Tool

The `console_execute` MCP tool allows agents and clients to evaluate arbitrary JavaScript inside the context of a browser tab, accurately simulating the behavior of the Chrome DevTools console.

## Features
- **Deep Serialization:** Automatically handles deeply nested objects, arrays, DOM Elements, Maps, Sets, and circular references.
- **Console Logs Interception:** Intercepts and returns any messages logged via `console.log`, `console.error`, `console.warn`, etc. during script evaluation.
- **DevTools APIs:** Supports DevTools-specific command line APIs like `$`, `$$`, `copy`, and `dir`.
- **Promises:** Awaits Promises returned by the expression by default.
- **Robust Exception Handling:** Safely captures and reports syntax, runtime, and serialization exceptions.

## Usage
When invoking the `console_execute` tool from an MCP client, provide the following parameters:

```json
{
  "tabId": 1, 
  "expression": "document.querySelectorAll('a').length",
  "awaitPromise": true,
  "timeoutMs": 30000
}
```

* `tabId` (optional): The ID of the target tab. Defaults to the active tab if omitted.
* `expression` (required): The JavaScript to evaluate.
* `awaitPromise` (optional): Boolean indicating if a returned Promise should be awaited (default: true).
* `timeoutMs` (optional): The max evaluation time in milliseconds (default: 30000, max: 60000).

## Output
Returns a JSON-stringified object containing the result, data type, intercepted logs, and any exceptions:
```json
{
  "result": 42,
  "type": "number",
  "logs": [
    {
      "type": "log",
      "args": ["Evaluation successful"]
    }
  ]
}
```
