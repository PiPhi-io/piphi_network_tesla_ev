import { app } from "./server.js";

const port = Number(process.env.PORT || 3090);
app.listen(port, () => {
  console.info(`Tesla EV runtime listening on port ${port}`);
});
