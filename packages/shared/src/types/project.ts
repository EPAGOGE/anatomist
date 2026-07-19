import { z } from 'zod';
import type { Brand } from './brand.js';

export type ProjectId = Brand<string, 'ProjectId'>;

export const ProjectIdSchema = z.string().uuid().brand<'ProjectId'>();
