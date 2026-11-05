export class UnderControlError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'UnderControlError'
    this.code = code
    this.details = details
  }
}
