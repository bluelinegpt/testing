import { HttpException } from "@nestjs/common";

export class ApplicationException extends HttpException {
  public constructor(
    public readonly errorCode: string,
    message: string,
    statusCode: number,
    public readonly validationDetails?: readonly string[],
  ) {
    super(message, statusCode);
  }
}
