export function loopError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}
