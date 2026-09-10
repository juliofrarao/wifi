import { useConfig } from '../config/ConfigProvider';
import { makeFormatters, type Formatters } from './formatters';

export { makeFormatters, formatCountdown, formatDuration } from './formatters';
export type { Formatters } from './formatters';

/** Formatters bound to the configured daycare time zone. */
export function useFormat(): Formatters {
  const { config } = useConfig();
  return makeFormatters(config.timezone);
}
