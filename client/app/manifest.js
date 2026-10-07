export default function manifest() {
  return {
    id: "/app", name: "Dots · Tus agentes personales", short_name: "Dots",
    description: "Un espacio para tus Dots: conversar, trabajar en equipo y crear.",
    start_url: "/app", scope: "/", display: "standalone", lang: "es",
    background_color: "#0e1420", theme_color: "#0e1420",
    icons: [{ src: "/app-icon.png", sizes: "1254x1254", type: "image/png", purpose: "any" }],
  };
}
