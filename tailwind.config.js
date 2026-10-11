// Antes Tailwind corría desde cdn.tailwindcss.com en el navegador: un script
// bloqueante de ~400 KB en cada visita (si el CDN tardaba, la página quedaba en
// negro) que además re-escaneaba el DOM con cada tanda de tarjetas. Ahora se
// compila en el build. `content` debe cubrir todo archivo con clases Tailwind.
import forms from '@tailwindcss/forms';
import containerQueries from '@tailwindcss/container-queries';

export default {
  content: ['./index.html', './src/**/*.js'],

        darkMode: "class",
        corePlugins: {
          preflight: false,
        },
        theme: {
          extend: {
            "colors": {
                    "secondary-fixed-dim": "#c8c6c5",
                    "on-error": "#690005",
                    "tertiary-fixed": "#e2e2e2",
                    "on-error-container": "#ffdad6",
                    "surface-container": "#201f1f",
                    "primary-fixed-dim": "#ffb59e",
                    "on-tertiary-fixed": "#1a1c1c",
                    "background": "#131313",
                    "on-tertiary-fixed-variant": "#454747",
                    "on-surface-variant": "#e6beb2",
                    "surface-variant": "#353534",
                    "surface-tint": "#ffb59e",
                    "on-tertiary-container": "#282a2a",
                    "surface-container-lowest": "#0e0e0e",
                    "outline-variant": "#5c4037",
                    "inverse-primary": "#ae3200",
                    "on-background": "#e5e2e1",
                    "error-container": "#93000a",
                    "inverse-surface": "#e5e2e1",
                    "primary": "#ffb59e",
                    "surface-dim": "#131313",
                    "primary-container": "#ff571a",
                    "on-secondary-container": "#b7b5b4",
                    "secondary-fixed": "#e5e2e1",
                    "inverse-on-surface": "#313030",
                    "surface-container-highest": "#353534",
                    "secondary-container": "#474746",
                    "tertiary-container": "#909191",
                    "on-secondary-fixed-variant": "#474746",
                    "surface": "#131313",
                    "secondary": "#c8c6c5",
                    "tertiary": "#c6c6c7",
                    "outline": "#ad897e",
                    "surface-container-low": "#1c1b1b",
                    "on-primary-container": "#521300",
                    "on-secondary-fixed": "#1c1b1b",
                    "on-primary": "#5e1700",
                    "surface-container-high": "#2a2a2a",
                    "surface-bright": "#3a3939",
                    "on-secondary": "#313030",
                    "on-primary-fixed-variant": "#852400",
                    "on-tertiary": "#2f3131",
                    "primary-fixed": "#ffdbd0",
                    "on-surface": "#e5e2e1",
                    "on-primary-fixed": "#3a0b00",
                    "error": "#ffb4ab",
                    "tertiary-fixed-dim": "#c6c6c7"
            },
            "borderRadius": {
                    "DEFAULT": "0.25rem",
                    "lg": "0.5rem",
                    "xl": "0.75rem",
                    "full": "9999px"
            },
            "spacing": {
                    "lg": "24px",
                    "3xl": "64px",
                    "margin-mobile": "16px",
                    "xs": "4px",
                    "sm": "8px",
                    "md": "16px",
                    "gutter": "20px",
                    "base": "8px",
                    "margin-desktop": "40px",
                    "2xl": "48px",
                    "xl": "32px"
            },
            "fontFamily": {
                    "label-md": ["Inter"],
                    "headline-md": ["Sora"],
                    "headline-lg-mobile": ["Sora"],
                    "body-md": ["Inter"],
                    "label-sm": ["Inter"],
                    "headline-lg": ["Sora"],
                    "display-lg-mobile": ["Sora"],
                    "display-lg": ["Sora"],
                    "body-lg": ["Inter"]
            },
            "fontSize": {
                    "label-md": ["14px", {"lineHeight": "1.2", "letterSpacing": "0.05em", "fontWeight": "600"}],
                    "headline-md": ["24px", {"lineHeight": "1.3", "fontWeight": "600"}],
                    "headline-lg-mobile": ["24px", {"lineHeight": "1.2", "fontWeight": "700"}],
                    "body-md": ["16px", {"lineHeight": "1.5", "fontWeight": "400"}],
                    "label-sm": ["12px", {"lineHeight": "1.2", "fontWeight": "500"}],
                    "headline-lg": ["32px", {"lineHeight": "1.2", "fontWeight": "700"}],
                    "display-lg-mobile": ["32px", {"lineHeight": "1.2", "letterSpacing": "-0.01em", "fontWeight": "800"}],
                    "display-lg": ["48px", {"lineHeight": "1.1", "letterSpacing": "-0.02em", "fontWeight": "800"}],
                    "body-lg": ["18px", {"lineHeight": "1.6", "fontWeight": "400"}]
            }
          },
        },
  plugins: [forms, containerQueries],
};
