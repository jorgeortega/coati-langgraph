# coati-langgraph

The [Latitude 10](https://latitude10.tech) support coati, rebuilt as a
[LangGraph.js](https://langchain-ai.github.io/langgraphjs/) agent running on
Cloudflare Workers, traced in LangSmith. It is the second agent in
[Latitude 10 Labs](https://latitude10.tech/labs); the first is the same coati on
Databricks ([coati-agent](https://github.com/jorgeortega/coati-agent)).

Work in progress: nothing here is deployed yet.

## Run it

```bash
npm ci
npm test
npx wrangler deploy --dry-run --outdir dist
```

## License

MIT
