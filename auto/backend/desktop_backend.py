import os

import uvicorn
import server


if __name__ == "__main__":
    os.environ.setdefault("STARS_SYNC_WHISPER_MODEL", "medium")
    os.environ.setdefault("STARS_SYNC_WHISPER_DEVICE", "auto")
    os.environ.setdefault("STARS_SYNC_WHISPER_COMPUTE", "auto")
    uvicorn.run(server.app, host="127.0.0.1", port=8765)
