# Venue Toll Facts — MCP server image.
# Zero runtime dependencies: Node's own http module serves the whole surface (HTTP routes + MCP over HTTP).
FROM node:22-alpine

WORKDIR /app

COPY server.js .
COPY market_map.json .

# The same source runs locally with an absolute Windows path; in the container the map is next to the server.
ENV MARKET_MAP=/app/market_map.json
# Bind all interfaces so the container's port is reachable by Glama's introspection check.
ENV HOST=0.0.0.0

EXPOSE 8791

CMD ["node", "server.js"]
