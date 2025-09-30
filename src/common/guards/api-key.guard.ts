import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

function norm(s: string | undefined | null) {
  return (s ?? '').trim();
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = String(req.headers['authorization'] || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    const expected = norm(this.config.get<string>('API_KEY'));

    if (!expected || norm(token) !== expected) {
      throw new UnauthorizedException('Invalid or missing API key');
    }
    return true;
  }
}
