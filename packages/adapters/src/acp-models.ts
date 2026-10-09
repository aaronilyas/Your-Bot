import type { ModelInfo } from '@your-bot/contracts';
import { AdapterError, record } from './errors.js';

export interface AcpModelSelector { id: string; current: string; models: ModelInfo[]; }

/** Current ACP v1 model selection uses select configOptions, not an unstable set_model method. */
export function modelSelector(raw: unknown): AcpModelSelector | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new AdapterError('INVALID_RESPONSE', 'Harness returned invalid configuration options.');
  const configs = raw.map(item => record(item));
  const option = configs.find(item => item.type === 'select' && item.category === 'model')
    ?? configs.find(item => item.type === 'select' && item.category == null && item.id === 'model');
  if (!option) return undefined;
  if (typeof option.id !== 'string' || !option.id || typeof option.currentValue !== 'string' || !Array.isArray(option.options)) throw new AdapterError('INVALID_RESPONSE', 'Harness returned an invalid model selector.');
  const values = option.options.flatMap(item => {
    const value = record(item);
    return Array.isArray(value.options) ? value.options.map(child => record(child)) : [value];
  });
  const seen = new Set<string>();
  const models = values.map(value => {
    if (typeof value.value !== 'string' || !value.value || seen.has(value.value) || typeof value.name !== 'string') throw new AdapterError('INVALID_RESPONSE', 'Harness returned invalid model options.');
    seen.add(value.value);
    return { id: value.value, name: value.name };
  });
  return { id: option.id, current: option.currentValue, models };
}
