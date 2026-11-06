export class AppError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requireFound(row, message = 'Resource not found') {
  if (!row) throw new AppError(404, message, 'NOT_FOUND');
  return row;
}
