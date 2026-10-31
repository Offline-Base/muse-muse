/**
 * The curated tool policy, edited by hand. `scripts/tools/sync-composio-catalog.ts` reads this, checks it against
 * Composio and writes lib/tools/composio/catalog.json. Products only ever see what the generated file holds.
 *
 * Three things here are decisions rather than data, and the spike in docs/spikes/composio-2026-10-31/ is the evidence:
 *
 * - The denylist is the real guard. A session's `tags: {disable: [...]}` does not remove a tool that `tools.enable`
 *   names, so a tag filter never protects a curated session.
 * - `keepParams` is an allowlist. Dropped parameters are what make a tool dangerous or dear: Firecrawl `actions` is
 *   browser automation and `jsonOptions` is an LLM call; Gmail accepts `to` as an alias for `recipient_email` that isn't in its schema, which would dodge the recipient count, and `user_id`
 *   reaches other mailboxes. The gateway must refuse any argument that is not in the catalog's parameters.
 * - `access` is ours, not Composio's. Composio tags FIRECRAWL_SCRAPE as createHint, and these tags change between
 *   toolkit versions, so `readDespiteTags` records each read tool that carries one.
 *
 * Owner's rule: Meta's web_search is the only general web search. One search action runs several queries, opens pages
 * from its results and finds text in them, so Tavily, SerpAPI web and news search, and Firecrawl search stay out.
 * A third-party tool is here only for what web_search lacks: structured records (scholar, places, events) and opening
 * an address the user gave (read_page), because Meta's open_page only opens URLs from search results.
 */

export type ToolTier = "public" | "personal";
export type ToolAccess = "read" | "create" | "update";

/** How the gateway turns a tool's output into source links. Paths are dotted, from the reply's `data`. */
export type SourceRule = {
  /** A list of results, or a single object when `single` is true. */
  path: string;
  single?: boolean;
  url: string;
  title: string;
  snippet?: string;
  date?: string;
};

/** What the gateway keeps of a tool's output before trimming it to size. */
export type OutputRule = {
  /** Dotted paths to keep. Everything else in the reply goes. */
  keep: string[];
  /** Keys to drop at any depth inside what was kept. */
  dropKeys: string[];
  /** Drop any string value that points at one of these hosts: provider links that carry account-specific paths. */
  dropUrlHosts?: string[];
};

export type FunctionPolicy = {
  slug: string;
  /** Written for the model. Composio's own text names dropped parameters and tools products can't call. */
  description: string;
  /** The only parameters the model sees and the gateway forwards. */
  keepParams: string[];
  /** Replaces the upstream `required` list when set. Must be a subset of keepParams. */
  required?: string[];
  /** Replaces an upstream parameter description that is wrong once other parameters are dropped. */
  paramDescriptions?: Record<string, string>;
  /** Replaces a parameter's whole schema, to narrow what it accepts. */
  paramSchemas?: Record<string, Record<string, unknown>>;
  /** Why a read tool may carry Composio's createHint or updateHint. Without it the sync refuses. */
  readDespiteTags?: string;
  /** Canned output for build tokens when a build has no fixture (2.8). URLs must be on example.com. */
  sample: unknown;
};

export type ToolPolicy = {
  id: string;
  label: string;
  /** Shown in a product's run steps while the tool works. */
  stepTitle: string;
  tier: ToolTier;
  access: ToolAccess;
  /** Absent for tools Meta runs itself. */
  toolkit?: string;
  builtin?: boolean;
  functions: FunctionPolicy[];
  /** Arguments that say who will be contacted. The gateway shows them on the confirmation and caps them. */
  recipientFields?: string[];
  /** Most calls a day per product, for tools that reach other people. Builds never count, because they never send. */
  perDay?: number;
  sources?: SourceRule[];
  output?: OutputRule;
  /**
   * True when `output` and `sources` were checked against a live reply. Gmail and Calendar weren't, because nobody has
   * connected an account yet, and their text hints at a `response_data` wrapper. Until the owner test, the gateway
   * should keep the whole reply (trimmed to size) if none of the `keep` paths match.
   */
  outputVerified?: boolean;
  /** Our own per-minute ceiling for this tool across the platform, not a published provider figure. */
  perMinute?: number;
};

/**
 * Toolkit versions the schemas were read at. Bump one by hand after reading what `--check` reports.
 *
 * Composio runs the latest version of a tool for every session call and every Instant call, whatever is pinned
 * (spike 05: "Instant accounts run the latest version"). So a pin fixes the schema products are given, not the code
 * that runs. The sync therefore refuses a pin whose kept parameters no longer exist at the latest version.
 */
export const TOOLKIT_PINS: Record<string, string> = {
  serpapi: "20261030_00",
  firecrawl: "20261030_00",
  gmail: "20261029_00",
  googlecalendar: "20261010_00",
  slack: "20261023_00",
};

/** Whole toolkits never allowed, by Composio slug. Patterns below catch variants such as `stripe_mcp`. */
export const DENIED_TOOLKITS: readonly string[] = [
  // Exa, including its old name. Off until Exa approves in writing, and through Composio too.
  "exa",
  "metaphor",
  // Composio's own meta tools and its retired search toolkit, which is partly Exa and partly Groq underneath.
  "composio",
  "composio_search",
  // LLMs: products call Meta only.
  "openai",
  "anthropic",
  "anthropic_administrator",
  "gemini",
  "perplexityai",
  "openperplex",
  "groqcloud",
  "grok",
  "mistral_ai",
  "cohere",
  "deepseek",
  "hugging_face",
  "replicate",
  "openrouter",
  "fireworks_ai",
  "llm_api",
  "ai_ml_api",
  "eden_ai",
  // Code execution.
  "e2b",
  "daytona",
  "codeinterpreter",
  "vast_ai",
  // Payments.
  "stripe",
  "stripe_mcp",
  "paypal",
  "square",
  "razorpay",
  "plaid_mcp",
  "wise",
  "coinbase",
  "coinbase_agents_mcp",
  "coinbase_wallet_mcp",
  "paystack",
  "flutterwave",
  "gocardless_mcp",
  "recurly",
  "whop",
  "polar",
  // SMS and voice.
  "twilio",
  "plivo",
  "telnyx",
  "vapi",
  "retellai",
  "bland_ai",
  "clicksend",
  "msg91",
  "seven_io",
  "sms_alert",
  "dialpad",
  "aircall",
  "elevenlabs",
  // Social posting.
  "twitter",
  "x_mcp",
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "reddit",
  "threads",
  "pinterest",
  "youtube",
  "snapchat",
  "whatsapp",
  "telegram",
  "discord",
  "discordbot",
  "buffer",
  "ayrshare",
  "bulkpublish",
  "postiz_mcp",
  "typefully",
  "upload_post",
  // Browser automation.
  "browser_tool",
  "browser_use",
  "browseract",
  "browserbase_mcp",
  "browserbase_tool",
  "browserless",
  "cloudflare_browser_rendering",
  "hyperbrowser",
  "skyvern",
  "airtop",
  "phantombuster",
];

/** Toolkit slugs caught by shape, so a new variant is refused before anyone adds it to the list. */
export const DENIED_TOOLKIT_PATTERNS: readonly RegExp[] = [
  /(^|_)exa(_|$)/,
  /^composio/,
  /openai|anthropic|perplexity|openrouter|groq/,
  /stripe|paypal|twilio|coinbase/,
  /browser/,
];

/**
 * Composio's own categories, read live by the sync. This catches the toolkits nobody thought to list: there are 45 in
 * "phone & sms" alone. "web scraping & browser" is left out because Firecrawl is in it.
 */
export const DENIED_CATEGORIES: readonly string[] = [
  "ai models",
  "payment processing",
  "phone & sms",
  "social media accounts",
  "social media marketing",
];

/** Slugs named outright, including the ones in otherwise allowed toolkits. */
export const DENIED_SLUGS: readonly string[] = [
  "EXA_SEARCH",
  "EXA_ANSWER",
  "EXA_GET_CONTENTS_ACTION",
  "COMPOSIO_SEARCH_WEB",
  "COMPOSIO_SEARCH_FETCH_URL_CONTENT",
  "COMPOSIO_SEARCH_EXA_ANSWER",
  "COMPOSIO_SEARCH_EXA_SIMILARLINK",
  "COMPOSIO_SEARCH_GROQ_CHAT",
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_REMOTE_BASH_TOOL",
  // Firecrawl runs an LLM for these, or searches people data.
  "FIRECRAWL_DEEP_RESEARCH",
  "FIRECRAWL_SEARCH_PEOPLE_APOLLO",
  "FIRECRAWL_SEARCH_PEOPLE_FULLENRICH",
  // Destructive by tag today. Named so a tag change upstream can't let them through.
  "GMAIL_SEND_DRAFT",
  "GMAIL_DELETE_DRAFT",
];

export const DENIED_SLUG_PATTERNS: readonly RegExp[] = [
  /(^|_)EXA(_|$)/,
  /^METAPHOR_/,
  /^COMPOSIO_/,
  /PROXY/,
  /WORKBENCH/,
  /REMOTE_BASH/,
  /CODE_INTERPRETER|EXECUTE_CODE|RUN_CODE/,
  /BROWSER/,
  /INTERACT/,
  /APOLLO/,
  /GROQ|LLM|CHAT_COMPLETION/,
  // Slack: nothing that deletes, or changes channels, members or workspace settings.
  /^SLACK_.*(DELETE|REMOVE|ARCHIVE|KICK|RENAME|ADMIN|UPDATE|SET_|INVITE|REVOKE)/,
];

export const denialOfToolkit = (toolkit: string): string | null => {
  const slug = toolkit.trim().toLowerCase();
  if (DENIED_TOOLKITS.includes(slug)) return `toolkit ${slug} is on the denylist`;
  const pattern = DENIED_TOOLKIT_PATTERNS.find((p) => p.test(slug));
  return pattern ? `toolkit ${slug} matches the denylist pattern ${pattern}` : null;
};

export const denialOfSlug = (toolSlug: string): string | null => {
  const slug = toolSlug.trim().toUpperCase();
  if (DENIED_SLUGS.includes(slug)) return `tool ${slug} is on the denylist`;
  const pattern = DENIED_SLUG_PATTERNS.find((p) => p.test(slug));
  return pattern ? `tool ${slug} matches the denylist pattern ${pattern}` : null;
};

const DROP_SERP_KEYS = [
  "about_page_link",
  "about_this_result",
  "data_cid",
  "data_id",
  "displayed_link",
  "event_token",
  "favicon",
  "inline_links",
  "order_online",
  "photos_link",
  "place_id_search",
  "provider_id",
  "read_more_link",
  "redirect_link",
  "resources",
  "reviews_link",
  "serpapi_thumbnail",
  "snippet_highlighted_words",
  "thumbnail",
];

/** Keeps each policy's id as a literal, so ToolId in lib/tools/ids.ts comes from this list alone. */
function policies<Id extends string>(list: Array<ToolPolicy & { id: Id }>) {
  return list;
}

export const TOOL_POLICIES = policies([
  {
    id: "web_search",
    label: "Web search",
    stepTitle: "Searching the web",
    tier: "public",
    access: "read",
    builtin: true,
    functions: [],
  },
  {
    id: "scholar",
    label: "Scholarly paper records",
    stepTitle: "Looking up papers",
    tier: "public",
    access: "read",
    toolkit: "serpapi",
    outputVerified: true,
    perMinute: 120,
    sources: [{ path: "results.organic_results", url: "link", title: "title", snippet: "snippet" }],
    output: { keep: ["results.organic_results"], dropKeys: DROP_SERP_KEYS, dropUrlHosts: ["serpapi.com"] },
    functions: [
      {
        slug: "SERPAPI_SCHOLAR_SEARCH",
        description:
          "Get structured records of scholarly papers from Google Scholar: title, link, authors, publication and a snippet. Use it only when you need those paper records. For general questions, use web_search.",
        keepParams: ["query", "num", "start"],
        sample: {
          results: {
            organic_results: [
              {
                position: 1,
                title: "A sample paper on your topic",
                link: "https://example.com/papers/sample-paper",
                snippet: "A short sample passage from the paper, standing in for a live result.",
                publication_info: { summary: "A Author, B Author - Example Journal, 2026" },
              },
            ],
          },
        },
      },
    ],
  },
  {
    id: "places",
    label: "Place records",
    stepTitle: "Looking up places",
    tier: "public",
    access: "read",
    toolkit: "serpapi",
    outputVerified: true,
    perMinute: 120,
    sources: [{ path: "results.local_results", url: "website", title: "title", snippet: "address" }],
    output: { keep: ["results.local_results"], dropKeys: DROP_SERP_KEYS, dropUrlHosts: ["serpapi.com"] },
    functions: [
      {
        slug: "SERPAPI_GOOGLE_MAPS_SEARCH",
        description:
          "Get structured records of places from Google Maps: name, address, rating, hours, phone and website. Use it only when you need those place records. For general questions, use web_search. Name the area in the query, such as 'coffee shops near Union Square San Francisco'. Not every place has a website.",
        keepParams: ["q", "ll", "start"],
        sample: {
          results: {
            local_results: [
              {
                position: 1,
                title: "Sample Place",
                address: "123 Example Street, Sample City",
                rating: 4.5,
                reviews: 120,
                type: "Sample business",
                hours: "Open until 7 PM",
                phone: "(555) 010-0100",
                website: "https://example.com/sample-place",
                gps_coordinates: { latitude: 37.78, longitude: -122.4 },
              },
            ],
          },
        },
      },
    ],
  },
  {
    id: "events",
    label: "Event records",
    stepTitle: "Finding events",
    tier: "public",
    access: "read",
    toolkit: "serpapi",
    outputVerified: true,
    perMinute: 60,
    // Google's event cards often have no link at all, and some queries return no cards, only web results.
    sources: [
      { path: "events_results", url: "link", title: "title", date: "date" },
      { path: "organic_results", url: "link", title: "title", snippet: "snippet" },
    ],
    output: { keep: ["events_results", "organic_results"], dropKeys: DROP_SERP_KEYS, dropUrlHosts: ["serpapi.com"] },
    functions: [
      {
        slug: "SERPAPI_EVENT_SEARCH",
        description:
          "Get structured event records from Google: title, date, time and address when Google has them, and web results otherwise. Use it only when you need those event records. For general questions, use web_search. Say what and where, such as 'Live music in Austin this weekend'. It can take about 10 seconds.",
        keepParams: ["query"],
        sample: {
          events_results: [
            {
              title: "Sample Community Event",
              date: "Nov 8",
              time: "7:00 PM",
              address: ["Sample Hall", "Sample City"],
              type: "Event",
            },
          ],
          organic_results: [
            {
              position: 1,
              title: "Sample events listing",
              link: "https://example.com/events",
              snippet: "A sample page of events, standing in for a live result.",
            },
          ],
        },
      },
    ],
  },
  {
    id: "read_page",
    label: "Read a page you link to",
    stepTitle: "Reading the page you linked",
    tier: "public",
    access: "read",
    toolkit: "firecrawl",
    outputVerified: true,
    perMinute: 120,
    sources: [{ path: "data.metadata", single: true, url: "url", title: "title" }],
    output: { keep: ["data.markdown", "data.metadata.title", "data.metadata.url"], dropKeys: [] },
    functions: [
      {
        slug: "FIRECRAWL_SCRAPE",
        description:
          "Read one public web page at an address the user gave you, and get its text as Markdown with its title and final address. Use it only for addresses from the user. web_search opens pages from its own results, so never use this for those.",
        keepParams: ["url", "onlyMainContent"],
        readDespiteTags: "It only reads one page. Composio tags it createHint anyway.",
        sample: {
          data: {
            markdown: "# Sample page\n\nSample text from the page, standing in for a live result.",
            metadata: { title: "Sample page", url: "https://example.com/articles/sample-result" },
          },
        },
      },
    ],
  },
  {
    id: "gmail_read",
    label: "Read Gmail",
    stepTitle: "Reading your email",
    tier: "personal",
    access: "read",
    toolkit: "gmail",
    perMinute: 60,
    output: { keep: ["messages", "nextPageToken", "messageId", "threadId", "subject", "sender", "to", "messageText", "messageTimestamp", "preview", "labelIds"], dropKeys: ["attachmentList", "payload"] },
    functions: [
      {
        slug: "GMAIL_FETCH_EMAILS",
        description:
          "Find messages in the connected Gmail account. Results are not sorted by date, so sort them yourself, and the list may be empty. To read one message in full, pass its id to GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID.",
        keepParams: ["query", "max_results", "page_token", "label_ids"],
        sample: {
          messages: [
            {
              messageId: "sample-message-1",
              threadId: "sample-thread-1",
              subject: "A sample email",
              sender: "Sample Sender <sender@example.com>",
              to: "you@example.com",
              messageTimestamp: "2026-10-30T15:00:00Z",
              preview: { body: "A sample preview of the message." },
              labelIds: ["INBOX"],
            },
          ],
        },
      },
      {
        slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        description: "Read one Gmail message by its id, which comes from GMAIL_FETCH_EMAILS.",
        keepParams: ["message_id", "format"],
        paramDescriptions: {
          message_id: "The message's id, from GMAIL_FETCH_EMAILS.",
          format: "'full' for the whole message (the default), 'metadata' for headers without the body, 'minimal' for ids and labels only.",
        },
        sample: {
          messageId: "sample-message-1",
          threadId: "sample-thread-1",
          subject: "A sample email",
          sender: "Sample Sender <sender@example.com>",
          to: "you@example.com",
          messageTimestamp: "2026-10-30T15:00:00Z",
          messageText: "The full text of a sample message.",
          labelIds: ["INBOX"],
        },
      },
    ],
  },
  {
    id: "gmail_draft",
    label: "Draft Gmail messages",
    stepTitle: "Drafting an email",
    tier: "personal",
    access: "create",
    toolkit: "gmail",
    perMinute: 30,
    recipientFields: ["recipient_email", "extra_recipients", "cc", "bcc"],
    output: { keep: ["id", "message.id", "message.threadId"], dropKeys: [] },
    functions: [
      {
        slug: "GMAIL_CREATE_EMAIL_DRAFT",
        description:
          "Save an email as a draft in the connected Gmail account. It sends nothing. Use a full email address for each recipient. The body is plain text. To reply in a thread, pass its thread_id.",
        keepParams: ["recipient_email", "extra_recipients", "cc", "bcc", "subject", "body", "thread_id"],
        paramDescriptions: {
          recipient_email: "The main recipient's full email address, such as 'user@example.com'.",
          extra_recipients: "More 'To' recipients' full email addresses.",
          cc: "Carbon copy recipients' full email addresses.",
          bcc: "Blind carbon copy recipients' full email addresses.",
          body: "The message, as plain text.",
        },
        sample: { id: "sample-draft-1", message: { id: "sample-message-2", threadId: "sample-thread-2" } },
      },
    ],
  },
  {
    id: "gmail_send",
    label: "Send Gmail messages",
    stepTitle: "Sending an email",
    tier: "personal",
    access: "create",
    toolkit: "gmail",
    perMinute: 10,
    perDay: 10,
    recipientFields: ["recipient_email", "extra_recipients", "cc", "bcc"],
    output: { keep: ["id", "threadId", "labelIds"], dropKeys: [] },
    functions: [
      {
        slug: "GMAIL_SEND_EMAIL",
        description:
          "Send an email from the connected Gmail account. It goes out at once and can't be undone. Use a full email address for each recipient, and give a subject, a body or both. The body is plain text.",
        keepParams: ["recipient_email", "extra_recipients", "cc", "bcc", "subject", "body"],
        required: ["recipient_email"],
        paramDescriptions: {
          recipient_email: "The main recipient's full email address, such as 'user@example.com'.",
          extra_recipients: "More 'To' recipients' full email addresses.",
          cc: "Carbon copy recipients' full email addresses.",
          bcc: "Blind carbon copy recipients' full email addresses.",
          body: "The message, as plain text. Give a subject, a body or both.",
        },
        sample: { id: "sample-sent-1", threadId: "sample-thread-3", labelIds: ["SENT"] },
      },
    ],
  },
  {
    id: "calendar_read",
    label: "Read Google Calendar",
    stepTitle: "Checking your calendar",
    tier: "personal",
    access: "read",
    toolkit: "googlecalendar",
    perMinute: 60,
    output: { keep: ["items", "nextPageToken", "timeZone"], dropKeys: ["etag", "iCalUID", "sequence", "creator", "organizer", "reminders"] },
    functions: [
      {
        slug: "GOOGLECALENDAR_EVENTS_LIST",
        description:
          "List events on the connected user's main Google Calendar. Use timeMin and timeMax for a window, query for text search, and singleEvents to expand repeating events. Sorting by start time needs singleEvents.",
        keepParams: ["query", "timeMin", "timeMax", "timeZone", "orderBy", "singleEvents", "maxResults", "pageToken"],
        sample: {
          items: [
            {
              id: "sample-event-1",
              summary: "Sample meeting",
              start: { dateTime: "2026-11-02T10:00:00-05:00" },
              end: { dateTime: "2026-11-02T10:30:00-05:00" },
              location: "Sample Room",
              htmlLink: "https://example.com/calendar/sample-event-1",
            },
          ],
        },
      },
    ],
  },
  {
    id: "calendar_add",
    label: "Add to Google Calendar",
    stepTitle: "Adding to your calendar",
    tier: "personal",
    access: "create",
    toolkit: "googlecalendar",
    perMinute: 30,
    // Attendees get an email from Google by default, so they count as recipients.
    recipientFields: ["attendees"],
    output: { keep: ["id", "summary", "start", "end", "location", "htmlLink", "attendees"], dropKeys: [] },
    functions: [
      {
        slug: "GOOGLECALENDAR_CREATE_EVENT",
        description:
          "Add an event to the connected user's main Google Calendar. For a timed event give start_datetime and either end_datetime or a duration. For an all-day event give start_date and an exclusive end_date. Google emails attendees unless send_updates says otherwise, and adds a Meet link.",
        keepParams: [
          "summary",
          "description",
          "location",
          "start_datetime",
          "end_datetime",
          "start_date",
          "end_date",
          "timezone",
          "event_duration_hour",
          "event_duration_minutes",
          "attendees",
          "send_updates",
        ],
        required: ["summary"],
        paramDescriptions: {
          description: "Notes for the event. Can contain HTML.",
          timezone: "IANA time zone name, such as 'America/New_York'. Needed when a time has no offset. The default is UTC.",
        },
        // Upstream also takes objects with an email inside. Strings only, so every recipient can be counted and shown.
        paramSchemas: {
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Attendees' full email addresses, such as 'user@example.com'.",
          },
        },
        sample: {
          id: "sample-event-2",
          summary: "Sample meeting",
          start: { dateTime: "2026-11-03T10:00:00-05:00" },
          end: { dateTime: "2026-11-03T10:30:00-05:00" },
          htmlLink: "https://example.com/calendar/sample-event-2",
        },
      },
    ],
  },
  {
    id: "slack_read",
    label: "Read Slack channels",
    stepTitle: "Reading Slack",
    tier: "personal",
    access: "read",
    toolkit: "slack",
    perMinute: 60,
    output: {
      keep: ["channels", "messages", "response_metadata.next_cursor"],
      dropKeys: ["blocks", "composio_execution_message", "previous_names", "team", "unread_count"],
    },
    functions: [
      {
        slug: "SLACK_FIND_CHANNELS",
        description:
          "Find channels in the connected Slack workspace by name, topic or purpose, and get their IDs. Other Slack tools need an ID, so look it up here first. It only sees what the connected account can see, so an empty result can mean no match or no access.",
        keepParams: ["query", "exact_match", "member_only", "limit", "cursor"],
        paramDescriptions: {
          limit: "How many channels to scan on this page, up to 999. The default is 50. Fewer may match.",
        },
        sample: {
          channels: [
            {
              id: "C0SAMPLE1",
              name: "sample-channel",
              topic: { value: "A sample channel topic" },
              is_private: false,
              num_members: 12,
            },
          ],
        },
      },
      {
        slug: "SLACK_FETCH_CONVERSATION_HISTORY",
        description:
          "Read messages from one Slack channel, by the ID from SLACK_FIND_CHANNELS. It returns the main timeline only, so replies inside threads aren't included. Use oldest and latest for a time window.",
        keepParams: ["channel", "limit", "oldest", "latest", "cursor"],
        paramDescriptions: {
          channel: "The channel's ID, from SLACK_FIND_CHANNELS.",
          limit: "How many messages to request, up to 1000. The default is 100. Slack may return fewer.",
          oldest: "Start of the time window, as a Unix or Slack timestamp such as '1234567890.000000'.",
          latest: "End of the time window, as a Unix or Slack timestamp such as '1234567890.000000'.",
        },
        sample: {
          messages: [
            {
              type: "message",
              user: "U0SAMPLE1",
              text: "A sample Slack message.",
              ts: "1761900000.000100",
              reply_count: 0,
            },
          ],
        },
      },
    ],
  },
  {
    id: "slack_search",
    label: "Search Slack",
    stepTitle: "Searching Slack",
    tier: "personal",
    access: "read",
    toolkit: "slack",
    perMinute: 30,
    output: { keep: ["messages.matches", "messages.total"], dropKeys: ["blocks", "iid", "team"] },
    functions: [
      {
        slug: "SLACK_SEARCH_MESSAGES",
        description:
          "Search messages across the connected Slack workspace. Put modifiers in the query, such as in:#channel, from:@user, has:link, before:YYYY-MM-DD or after:YYYY-MM-DD. Set count, because the default is a single message.",
        keepParams: ["query", "count", "page", "sort", "sort_dir"],
        paramDescriptions: {
          query: "What to search for. Modifiers: in:#channel, in:@user, from:@user, has:link, has:file, before:YYYY-MM-DD, after:YYYY-MM-DD.",
          count: "How many messages per page, up to 100. The default is 1, so set it.",
          page: "Which page of results to return.",
        },
        sample: {
          messages: {
            total: 1,
            matches: [
              {
                text: "A sample Slack message that matches your search.",
                ts: "1761900000.000100",
                username: "sample.user",
                channel: { id: "C0SAMPLE1", name: "sample-channel" },
                permalink: "https://example.com/slack/archives/C0SAMPLE1/p1761900000000100",
              },
            ],
          },
        },
      },
    ],
  },
  {
    id: "slack_send",
    label: "Send Slack messages",
    stepTitle: "Sending a Slack message",
    tier: "personal",
    access: "create",
    toolkit: "slack",
    perMinute: 10,
    perDay: 10,
    // One channel can be a whole workspace, so the confirmation has to show where it goes.
    recipientFields: ["channel"],
    output: { keep: ["ok", "channel", "ts"], dropKeys: [] },
    functions: [
      {
        slug: "SLACK_SEND_MESSAGE",
        description:
          "Post a message to one Slack channel. It posts at once, and a repeated call posts a duplicate. Write the message in Markdown. To reply in a thread, pass the parent message's thread_ts.",
        // `blocks` can carry buttons, and `reply_broadcast` widens a thread reply to the whole channel. `channel_id` is
        // an alias outside the schema, refused for the same reason as Gmail's `to`.
        keepParams: ["channel", "markdown_text", "thread_ts"],
        required: ["channel", "markdown_text"],
        paramDescriptions: {
          channel: "The channel's ID from SLACK_FIND_CHANNELS, or its name without the #.",
          markdown_text: "The message, in standard Markdown.",
        },
        sample: { ok: true, channel: "C0SAMPLE1", ts: "1761900000.000200" },
      },
    ],
  },
]);
