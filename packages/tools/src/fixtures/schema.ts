import { z } from 'zod';
import { ProfileNameSchema } from '@crosscheck/core';
export const FixtureInputSchema=z.strictObject({name:ProfileNameSchema});
export const FIXTURE_NOTICE='返回值仅为准备用例变量与完成凭证，非预期判定依据';
