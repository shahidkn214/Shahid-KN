import os
import uvicorn

if __name__ == "__main__":
    # Safely parse PORT provided by Render, Railway, Cloud Run, Heroku or fallback to 8000
    raw_port = os.environ.get("PORT", "8000").strip()
    try:
        port = int(raw_port)
    except (ValueError, TypeError):
        port = 8000

    print(f"🚀 Starting Nexversal Server on host 0.0.0.0 port {port}...")
    uvicorn.run("main:app", host="0.0.0.0", port=port, workers=2, access_log=True)
