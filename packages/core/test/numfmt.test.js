import { describe, it, expect } from 'vitest';
import { createFormatter } from '../src/xlsx/index.js';

const en = createFormatter({ locale: 'en' });
const ru = createFormatter({ locale: 'ru' });
const T = [
  [1234.5, '#,##0.00', '1,234.50'], [0.256, '0%', '26%'], [0.256, '0.0%', '25.6%'], [1234.5, '0.00E+00', '1.23E+03'],
  [-5, '0;(0)', '(5)'], [0, '0;-0;"zero"', 'zero'], [3.14159, '0.00', '3.14'], [5, '0.00', '5.00'], [0.5, '#.##', '.5'], [5, '#.##', '5.'],
  [45000, 'dd.mm.yyyy', '15.03.2023'], [45000.5, 'dd.mm.yyyy hh:mm', '15.03.2023 12:00'], [0.5, 'h:mm AM/PM', '12:00 PM'],
  [1.5, '[h]:mm', '36:00'], [1234567, '#,##0', '1,234,567'], [1234567, '#,##0,', '1,235'], [1234567, '0.0,,"M"', '1.2M'],
  [12.5, '# ?/?', '12 1/2'], [0.75, '# ?/?', '3/4'], ['abc', '@', 'abc'], ['abc', '"Mr. "@', 'Mr. abc'], [1, '0000', '0001'], [5, '000-000', '000-005'],
  [1234567890, '(###) ###-####', '(123) 456-7890'], [1e-7, 'General', '1E-07'], [123456789012, 'General', '1.23457E+11'], [0.1 + 0.2, 'General', '0.3'], [1 / 3, 'General', '0.333333333333333'],
  [12345.6789012, 'General', '12345.6789012'], [-12.5, 'General', '-12.5'], [1.005, '0.00', '1.01'], [2.675, '0.00', '2.68'], [-1234.567, '#,##0.00', '-1,234.57'],
  [1234.5, '#,##0.00;[Red]-#,##0.00', '1,234.50'], [-1234.5, '#,##0.00;[Red]-#,##0.00', '-1,234.50'], [150, '[>100]"big";"small"', 'big'], [50, '[>100]"big";"small"', 'small'],
  [45000, 'yyyy-mm-dd', '2023-03-15'], [45000.75, 'h:mm:ss', '18:00:00'], [45000, 'dddd', 'Wednesday'], [45000, 'mmmm d, yyyy', 'March 15, 2023'], [45000.0006, 'hh:mm:ss.00', '00:00:51.84'],
  [1.5, 'mm:ss', '00:00'], [0.0104166667, 'mm:ss', '15:00'], [true, 'General', 'TRUE'], [0, '0.00', '0.00'], [-0.5, '0%', '-50%'], [1234.5, '"$"#,##0.00', '$1,234.50'], [1234, '[$₽-419]#,##0', '₽1,234'],
  [12, '0.0"°"', '12.0°'], [99.5, '0', '100'], [0.000012345, '0.00E+00', '1.23E-05'], [123456, '##0.0E+0', '123.5E+3'], [0.05, '0.0%', '5.0%'], [1000, '#,##0_);(#,##0)', '1,000'],
];
const R = [[1234.5, '#,##0.00', '1 234,50'], [45000, 'd mmmm yyyy', '15 марта 2023'], [45000, 'mmmm', 'март'], [45000, 'dd.mm.yyyy', '15.03.2023'], [45000, 'ddd', 'ср'], [true, 'General', 'ИСТИНА'], [0.256, '0.0%', '25,6%']];

describe('number formats (what a cell shows)', () => {
  it('renders numbers, dates and text like Excel does, English separators', () => {
    const bad = T.filter(([v, c, want]) => en.show(v, c) !== want).map(([v, c, want]) => [c, v, want, en.show(v, c)]);
    expect(bad).toEqual([]);
  });
  it('uses the Russian separators, month names and TRUE/FALSE words', () => {
    const bad = R.filter(([v, c, want]) => ru.show(v, c) !== want).map(([v, c, want]) => [c, v, want, ru.show(v, c)]);
    expect(bad).toEqual([]);
  });
  it('system long date/time codes and 1904 workbooks', () => {
    expect(en.show(45000, '[$-F800]dddd\,\ mmmm\ dd\,\ yyyy')).toBe('Wednesday, March 15, 2023');
    expect(createFormatter({ date1904: true }).show(1, 'yyyy-mm-dd')).toBe('1904-01-02');
  });
  it('shows a number in a text-only ("@") cell as it is, and the Taiwanese era year', () => {
    expect(en.show(22500951, '@')).toBe('22500951');
    expect(en.show(-1.5, '@')).toBe('-1.5');
    expect(en.show('abc', '@')).toBe('abc');
    expect(en.show(45368, '[$-404]e/m/d')).toBe('113/3/17');
  });
  it('never throws on hostile format codes', () => {
    for (const c of ['[', '"', '0.0.0.0', ';;;;;', '[>', '[h', 'E+', '?/?/?', '#'.repeat(300), '\\', '[Red]', '[$-', '0/0']) {
      expect(typeof en.show(1234.5, c) === 'string' || en.show(1234.5, c) === null).toBe(true);
    }
  });
});
