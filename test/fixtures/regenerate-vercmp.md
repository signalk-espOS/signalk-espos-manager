# Regenerating `version-compare.json`

The expected values in `version-compare.json` are not hand-written: they are
the output of espOS's own `espos_ota_version_cmp`, compiled from the firmware
source. The plugin and the device must never disagree about which build is
newer, so the fixture is generated from the authority rather than from
reasoning about it.

To regenerate after a firmware change:

```sh
# 1. Extract the two functions into a standalone harness.
python3 - <<'PY'
import re, pathlib
src = pathlib.Path("path/to/espOS/components/espos_ota/src/manifest.c").read_text()
core = re.search(r"static int parse_core.*?\n\}\n", src, re.S).group(0)
cmp_ = re.search(r"int espos_ota_version_cmp.*?\n\}\n", src, re.S).group(0)
pathlib.Path("vercmp.c").write_text(
    '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n'
    '#include <ctype.h>\n#include <stdbool.h>\n\n'
    + core + "\n" + cmp_ +
    'int main(int argc, char **argv) {\n'
    '    if (argc != 3) return 2;\n'
    '    printf("%d\\n", espos_ota_version_cmp(argv[1], argv[2]));\n'
    '    return 0;\n}\n')
PY

# 2. Build it and use it as the oracle.
gcc -O0 -o vercmp vercmp.c
./vercmp 1.1.0-12-g44590ce 1.1.0   # -> -1
```

The TypeScript port in `src/mirror/manifest.ts` was checked against this
oracle over 3000 randomly generated version pairs with zero mismatches, on
top of the table recorded here.
