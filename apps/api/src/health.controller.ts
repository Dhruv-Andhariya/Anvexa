import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/auth';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'api' };
  }
}
