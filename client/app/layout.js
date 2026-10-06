import "./globals.css";
import "./dots-interface.css";

export const metadata = {
  title: "Dots · Tu espacio para pensar y crear",
  description:
    "Tus agentes personales para conversar, recordar y avanzar con tus proyectos.",
  openGraph: {
    title: "Dots · Tu espacio para pensar y crear",
    description:
      "Un espacio personal para tus ideas, conversaciones y agentes.",
    type: "website",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="es" className="dark" suppressHydrationWarning={true}>
      <body className="bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
