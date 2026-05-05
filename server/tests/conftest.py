import sys
import types
from unittest.mock import AsyncMock, MagicMock


# Unit tests patch cloakbrowser at source, while some environments running the
# suite do not have the optional cloakbrowser package installed. Provide a tiny
# importable shim so unittest.mock.patch("cloakbrowser.*") can attach mocks; the
# real runtime still imports the installed package when present.
if "cloakbrowser" not in sys.modules:
    module = types.ModuleType("cloakbrowser")
    module.ensure_binary = MagicMock(return_value="/tmp/fake-cloakbrowser")
    module.launch_async = AsyncMock()
    sys.modules["cloakbrowser"] = module
