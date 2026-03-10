import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '../prophetlabs_23_B_W_ORANGE_BLUE_AURORA_REV22.jsx'

// Polyfill window.storage for standard web browsers
if (!window.storage) {
    window.storage = {
        get: async (key) => {
            const val = localStorage.getItem(key);
            return val ? { value: val } : null;
        },
        set: async (key, val) => localStorage.setItem(key, val),
        list: async (prefix, returnKeysOnly) => {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k.startsWith(prefix)) keys.push(k);
            }
            return returnKeysOnly ? keys : keys.map(k => ({ key: k, value: localStorage.getItem(k) }));
        },
        remove: async (key) => localStorage.removeItem(key)
    };
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
