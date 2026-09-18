The TypeScript framing, CRC, Select.live tunnel, and inverter authentication implementation
was written with reference to selpi by David Schoen:
https://github.com/neerolyte/selpi/tree/68f144f0175a31a3ac1adf9019168d3ee26ee7b4

The MIT notice for that work follows. History traversal and decoding were independently
implemented from interoperability facts observed in SP LINK 16.11.9663. No vendor binaries
or decompiled source are included in this repository.

`event-labels.json` carries the event-code and state-enum tables that the same SP LINK build
maps codes to, resolved by offline inspection of its enum switches. They are interoperability
facts, needed to read our own inverter's logs: without them a stored event is an integer.
They are data tables, not code, and no vendor binary, installer or decompiled source is
redistributed. The file records the software version, the assembly hash and the method.

Copyright 2019 David Schoen.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
