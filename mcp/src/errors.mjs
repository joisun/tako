export class TAKOError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'TAKOError'
    this.code = code
    this.details = details
  }
}
