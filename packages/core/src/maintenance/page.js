export { renderErrorPage } from '../http/error-pages.js';
import { catalogFor } from '../http/error-catalog.js';

/** The `maintenance` entry of the error catalog for one language (title, message, hint, until, retry). */
export function catalogForMaintenance(locale = 'ru') {
  return catalogFor(locale).maintenance;
}
