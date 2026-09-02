import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import { Web3Provider } from "@/components/Web3Provider";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "GammaShield — BTC/ETH options amplification risk",
  description:
    "Real-time market amplification risk engine on Thetanuts V4 (Base). Measures how vulnerable the market is to feedback loops — not where price goes next.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><Web3Provider>{children}</Web3Provider></body>
    </html>
  );
}
