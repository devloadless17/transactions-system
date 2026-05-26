import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Skip the JwtAuthGuard for the decorated route. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
