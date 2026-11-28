import base64
import struct
import sys
import unittest
from pathlib import Path

from tests import helpers  # noqa: F401
from flashcards import shortcut

STATIC = Path(__file__).resolve().parents[1] / "static"


class ShortcutTest(unittest.TestCase):
    def test_command_and_env(self):
        cmd, env = shortcut.build_command(Path("C:/Users/山田/Documents/薬剤師/app"))
        self.assertEqual(cmd[0], "powershell.exe")
        script = base64.b64decode(cmd[-1]).decode("utf-16-le")
        self.assertIn("CreateShortcut", script)
        self.assertIn("GetFolderPath('Desktop')", script)
        self.assertIn("OutputEncoding", script)
        self.assertEqual(env["YF_COUNT"], "2")
        self.assertEqual(env["YF_NAME_0"], "国試フラッシュカード")
        self.assertTrue(env["YF_TARGET_0"].endswith("start.bat"))
        self.assertTrue(env["YF_TARGET_1"].endswith("start_ipad.bat"))
        self.assertTrue(env["YF_ICON"].endswith("icon.ico"))
        self.assertNotIn("山田", script)   # パスはスクリプトに埋め込まず環境変数で渡す

    def test_bat_files_exist(self):
        for _, bat, _ in shortcut.SHORTCUTS:
            self.assertTrue((shortcut.APP_DIR / bat).exists(), bat)
        self.assertTrue((shortcut.APP_DIR / "create_shortcut.bat").exists())

    @unittest.skipIf(sys.platform == "win32", "Windows 以外での動作の確認")
    def test_non_windows_refuses(self):
        with self.assertRaises(RuntimeError):
            shortcut.create_desktop_shortcuts()

    def test_icon_file(self):
        data = (STATIC / "icon.ico").read_bytes()
        reserved, kind, count = struct.unpack_from("<HHH", data, 0)
        self.assertEqual((reserved, kind), (0, 1))
        self.assertGreaterEqual(count, 4)
        sizes = []
        for i in range(count):
            w, h, _, _, _, _, size, offset = struct.unpack_from("<BBBBHHII", data, 6 + 16 * i)
            self.assertEqual(data[offset:offset + 8], b"\x89PNG\r\n\x1a\n")
            self.assertLessEqual(offset + size, len(data))
            sizes.append(w or 256)
        for s in (16, 32, 48, 256):
            self.assertIn(s, sizes)
        self.assertTrue((STATIC / "apple-touch-icon.png").read_bytes().startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()
