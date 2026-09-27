import http from "node:http";

const port = Number(process.argv[2]);
const dataDir = process.argv[3];
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(dataDir);
}).listen(port, "127.0.0.1");
