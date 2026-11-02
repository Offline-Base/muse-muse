# Linking Claude or ChatGPT

The connector is a remote MCP server behind the relay's OAuth (dynamic client registration, client ID metadata documents, PKCE S256 only), so it is not tied to Muse. Claude's custom connectors and ChatGPT's developer mode both take that kind of server. Muse stays the main app for this project; this page is for anyone who uses Claude or ChatGPT instead, or as well.

**Status, Oct 31.** Both apps were linked for real on Oct 31 ([build log](BUILD_LOG.md), 18:38 to 19:04):

- **Claude** linked through its custom connectors with its published client ID metadata document, so nothing was registered by hand. Its first tool call, an ask on the invented essays folder, finished on the device in about 40 s, but Claude polled `get_result` about a dozen times inside that window and stopped to say it was still working. On "check again" it fetched the result, which the device shared. The running message still gives no wait time.
- **ChatGPT** linked in developer mode. Its first chat failed with a 400 on every call: the MCP library answers 400 when a request lacks the `Mcp-Method` and `Mcp-Name` headers, and the relay dropped them. The relay client now forwards them and fills a missing one from the body. After a device restart, ChatGPT ran a search and two asks, all answered 200, and the device kept all three answers back. One ask was about a real resume that had been left in the demo workspace; it was moved out and replaced with an invented one. As of that log entry, the deployed relay itself still dropped the two headers, which needs a redeploy.

That is a few calls in each app, not a measured session, and there's no report for either in `eval/reports`.

`RUN_INTEGRATION=1 uv run pytest tests/test_relay_e2e.py` runs the whole link on this machine with a script that registers as Claude, as ChatGPT and as Muse: discovery, registration, the pairing page, the token, then MCP initialize, tools/list and a tools/call that comes back tagged. All three pass. That shows nothing in the relay or the device is tied to Muse. It does not by itself show how those apps' real clients behave; the calls above do, for a few requests. Update this page when a session in either app has a report.

## On the device

1. Set the app's name in `.env`, so the device's pages, receipts and notes name it, then restart:

   ```
   LINKED_APP=Claude        # or ChatGPT, or Muse (the default)
   ```

   The device cannot tell from a single call which app sent it. With several apps linked, use a general name such as `LINKED_APP=your AI app`.
2. Register the device with the relay and make a pairing code, as in [docs/MUSE_SETUP.md](MUSE_SETUP.md) steps 1 and 4:

   ```
   uv run python -m base.connector.relay_client register --name "Laptop"   # once
   uv run python -m base.connector.relay_client pair                       # a code that works once, for 10 minutes
   ```

## Claude

From Claude's help center ("Building custom connectors via remote MCP servers", read Oct 31 through a search): remote custom connectors are on the Pro, Max, Team and Enterprise plans; Claude supports dynamic client registration, Streamable HTTP and SSE; its OAuth client is named Claude and its callback is `https://claude.ai/api/mcp/auth_callback`. The relay limits neither.

1. In Claude, open Settings, then Connectors, and add a custom connector.
2. Name it Muse Privacy, and give the URL `https://muse-privacy-relay.<your-subdomain>.workers.dev/mcp`. Leave the OAuth client ID and secret empty: Claude registers itself.
3. Connect. The relay's page opens and asks for the pairing code from step 2 above.
4. In Claude's privacy settings, turn off Help improve Claude, if you have not. Check the setting's current name in the app.

## ChatGPT

From third-party guides, not OpenAI's own pages (read Oct 31): a custom MCP connector needs Developer mode, which depends on the plan and on an admin for business plans; ChatGPT needs Streamable HTTP and registers itself by dynamic client registration or a client ID metadata document. Check OpenAI's help center before relying on this.

1. In ChatGPT, open Settings, then Apps and Connectors, then Advanced settings, and turn on Developer mode.
2. Create a connector named Muse Privacy with the MCP server URL `https://muse-privacy-relay.<your-subdomain>.workers.dev/mcp` and OAuth sign-in.
3. Connect. The relay's page asks for the pairing code.
4. Under Data controls, turn off Improve the model for everyone, if you have not.

## What each app gets

The same as Muse: only tagged or summarized results that passed the router and the final check, and nothing at all under the CUI, CJIS and export toggles. Whatever you type into the app reaches its maker before the device sees it, so use Prepare a question for anything private. Each app's own data rules apply to what it receives; Muse's connector terms bar using connector data for training, and the other apps' terms are their own.

## Not done yet

- The relay's link-expired page still says "Start linking again from Muse". Fixing it means redeploying the relay, which is Ethan's call.
- No session in either app has been run or recorded.
- Approvals show one app name for the device. Showing which app sent each request would need the relay to pass the app's name down with each call, and a redeploy.
