from flask import Flask, request, Response, jsonify
from flask_cors import CORS
import os, asyncio, re
from telethon import TelegramClient
from telethon.sessions import StringSession

app = Flask(__name__)
CORS(app)

API_ID = int(os.environ.get('API_ID', '37646525'))
API_HASH = os.environ.get('API_HASH', '')
BOT_TOKEN = os.environ.get('BOT_TOKEN', '')

client = None
async def get_client():
    global client
    if client is None:
        client = TelegramClient(StringSession(), API_ID, API_HASH)
        await client.start(bot_token=BOT_TOKEN)
    return client

def parse_tg_link(url):
    m = re.search(r't\.me/c/(\d+)/(\d+)', url)
    if m:
        return int("-100" + m.group(1)), int(m.group(2))
    m2 = re.search(r't\.me/([^/]+)/(\d+)', url)
    if m2:
        return m2.group(1), int(m2.group(2))
    return None, None

@app.route('/')
def home():
    return jsonify({"ok": True, "msg": "AlQaqa API Online", "has_keys": bool(API_HASH and BOT_TOKEN)})

@app.route('/stream')
def stream():
    url = request.args.get('url')
    chat_id, msg_id = parse_tg_link(url)
    if not chat_id:
        return "bad link", 400
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        async def run():
            c = await get_client()
            msg = await c.get_messages(chat_id, ids=msg_id)
            if not msg or not msg.media:
                return None
            data = await c.download_media(msg, file=bytes)
            return data
        data = loop.run_until_complete(run())
        loop.close()
        if not data:
            return "no media", 404
        return Response(data, mimetype="video/mp4", headers={'Access-Control-Allow-Origin': '*'})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 10000)))
