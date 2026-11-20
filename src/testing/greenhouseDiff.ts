// Invented Python file: the second hunk starts inside the docstring opened on line 5.
export const greenhousePath = 'greenhouse.py';
const python = (count: number, result: string) =>
  [
    `COUNT = ${count}`,
    'LABEL = "fern"',
    '',
    'def tend():',
    '    """Guide to the greenhouse.',
    '',
    '    Sort the seedlings by height.',
    '    Add fresh soil for each tray.',
    '    if a leaf is dry, move its pot.',
    '    Select the east bed.',
    '    """',
    `    return COUNT + ${result}`,
    '',
    'READY = True',
    '',
  ].join('\n');
export const greenhouseBefore = python(1, '1');
export const greenhouseAfter = python(2, '2');
export const greenhousePatch = [
  '@@ -1,2 +1,2 @@',
  '-COUNT = 1',
  '+COUNT = 2',
  ' LABEL = "fern"',
  '@@ -9,6 +9,6 @@',
  '     if a leaf is dry, move its pot.',
  '     Select the east bed.',
  '     """',
  '-    return COUNT + 1',
  '+    return COUNT + 2',
  ' ',
  ' READY = True',
].join('\n');
