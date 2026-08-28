import { ensurePriceStream, latestPrices, marketEvents, type PriceEvent } from "@/lib/stream";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  ensurePriceStream();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      // Everything we already know, immediately.
      send("init", [...latestPrices.values()]);

      const onPrice = (ev: PriceEvent) => send("price", ev);
      marketEvents.on("price", onPrice);

      const heartbeat = setInterval(
        () => controller.enqueue(encoder.encode(`: hb\n\n`)),
        15_000,
      );

      const close = () => {
        marketEvents.off("price", onPrice);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}
