import { describe, expect, it } from 'bun:test'
import type { BrowserSession } from '@browseros/browser-core/core/session'
import { console_execute } from './console'
import { executeTool } from './framework'

function sessionWithConsoleMock(
  mockEvaluate: (params: any) => any,
  mockCallFunctionOn: (params: any) => any,
  mockEnable: () => Promise<void> = async () => {},
  mockOn: (event: string, handler: any) => () => void = () => () => {},
): BrowserSession {
  return {
    pages: {
      getTabs: () => [1],
      getSession: async () => ({
        session: {
          Runtime: {
            enable: mockEnable,
            on: mockOn,
            evaluate: async (params: any) => mockEvaluate(params),
            callFunctionOn: async (params: any) => mockCallFunctionOn(params),
          },
        },
      }),
      getInfo: () => ({ url: 'https://example.com/console' }),
    },
  } as unknown as BrowserSession
}

function textOf(result: { content?: unknown } | undefined): string {
  if (!Array.isArray(result?.content)) return ''
  return result.content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n')
}

describe('console_execute tool', () => {
  it('returns primitives successfully', async () => {
    const session = sessionWithConsoleMock(
      (params) => ({
        result: { type: 'number', value: 42, description: '42' }
      }),
      (params) => {
        // Mock serialization for primitive
        return { result: { value: params.arguments.map((a: any) => a.value) } }
      }
    )

    const result = await executeTool(
      console_execute,
      { tabId: 1, expression: '42' },
      { session }
    )

    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(textOf(result))
    expect(parsed.result).toBe(42)
    expect(parsed.type).toBe('number')
  })

  it('handles objects and complex types via serialization', async () => {
    const session = sessionWithConsoleMock(
      (params) => ({
        result: { type: 'object', objectId: 'obj1' }
      }),
      (params) => {
        return { result: { value: [{ foo: 'bar' }] } }
      }
    )

    const result = await executeTool(
      console_execute,
      { tabId: 1, expression: '({ foo: "bar" })' },
      { session }
    )

    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(textOf(result))
    expect(parsed.result).toEqual({ foo: 'bar' })
    expect(parsed.type).toBe('object')
  })

  it('handles exceptions in evaluation', async () => {
    const session = sessionWithConsoleMock(
      (params) => ({
        exceptionDetails: {
          text: 'Uncaught',
          exception: { objectId: 'err1' }
        }
      }),
      (params) => {
        return { result: { value: [{ __type: 'error', message: 'Something broke' }] } }
      }
    )

    const result = await executeTool(
      console_execute,
      { tabId: 1, expression: 'throw new Error("Something broke")' },
      { session }
    )

    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(textOf(result))
    expect(parsed.exception.__type).toBe('error')
    expect(parsed.exception.message).toBe('Something broke')
  })

  it('captures console logs', async () => {
    const session = sessionWithConsoleMock(
      (params) => ({
        result: { type: 'undefined' }
      }),
      (params) => {
        return { result: { value: params.arguments.map((a:any) => a.value) } }
      },
      async () => {},
      (event, handler) => {
        if (event === 'consoleAPICalled') {
          handler({ type: 'log', args: [{ type: 'string', value: 'Hello log' }] })
        }
        return () => {}
      }
    )

    const result = await executeTool(
      console_execute,
      { tabId: 1, expression: 'console.log("Hello log")' },
      { session }
    )

    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(textOf(result))
    expect(parsed.logs.length).toBe(1)
    expect(parsed.logs[0].type).toBe('log')
    expect(parsed.logs[0].args).toEqual(['Hello log'])
  })
})
