import type { Metadata } from "next";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/manrope";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hedge LBank",
  description: "Cross-exchange hedge terminal",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><head><link rel="icon" type="image/png" href="./app-icon.png" /></head><body>{children}</body></html>;
}
