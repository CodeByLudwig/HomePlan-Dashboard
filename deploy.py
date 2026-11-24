import ftplib
import os

HOST = os.environ.get("HOMEY_HOST", "192.168.1.100")
PORT = int(os.environ.get("HOMEY_FTP_PORT", "5081"))
REMOTE_DIR = os.environ.get("HOMEY_REMOTE_DIR", "/homeplan")

FILES = [
    "index.html",
    "sw.js",
    "manifest.webmanifest",
    "icon.svg",
    "icon-192.png",
    "icon-512.png",
    "config.json",
    "css/dashboard.css",
    "css/3d.css",
    "js/dashboard.js",
    "js/i18n.js",
    "js/scene-core.js",
    "js/devices-3d.js",
    "js/ha-connector.js",
    "js/homey-api.js",
    "js/animations-fpv.js",
    "js/house-editor.js",
]


def ensure_dir(ftp, path):
    parts = [p for p in path.split("/") if p]
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            ftp.cwd(cur)
        except ftplib.error_perm:
            ftp.mkd(cur)
            ftp.cwd(cur)


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    ftp = ftplib.FTP()
    ftp.connect(HOST, PORT, timeout=10)
    ftp.login()
    ftp.set_pasv(False)

    for rel in FILES:
        local_path = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.exists(local_path):
            continue
        sub = os.path.dirname(rel)
        target_dir = f"{REMOTE_DIR}/{sub}" if sub else REMOTE_DIR
        ensure_dir(ftp, target_dir)
        fname = os.path.basename(rel)
        with open(local_path, "rb") as f:
            ftp.storbinary(f"STOR {fname}", f)
        print(f"Uploaded {rel} ({os.path.getsize(local_path)} bytes)")

    ftp.quit()
    print("Deploy abgeschlossen.")


if __name__ == "__main__":
    main()
