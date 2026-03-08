// Wait for DOM
document.addEventListener('DOMContentLoaded', () => {

    // --- Theme Toggle Logic ---
    const themeToggleBtn = document.getElementById('theme-toggle');
    const applyTheme = (theme) => {
        document.body.classList.remove('dark-mode', 'light-mode');
        document.body.classList.add(theme === 'light' ? 'light-mode' : 'dark-mode');
        localStorage.setItem('portfolioTheme', theme);
    };

    // Apply saved theme (defaults to dark if nothing is saved).
    const savedTheme = localStorage.getItem('portfolioTheme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
        applyTheme(savedTheme);
    } else if (!document.body.classList.contains('dark-mode') && !document.body.classList.contains('light-mode')) {
        applyTheme('dark');
    }

    themeToggleBtn.addEventListener('click', () => {
        const nextTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
        applyTheme(nextTheme);
    });

    // --- Scroll Animations (Intersection Observer) ---
    const fadeElements = document.querySelectorAll('.fade-in');

    const appearOptions = {
        threshold: 0.15,
        rootMargin: "0px 0px -50px 0px"
    };

    const appearOnScroll = new IntersectionObserver(function (entries, observer) {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;

            entry.target.classList.add('appear');
            observer.unobserve(entry.target);
        });
    }, appearOptions);

    fadeElements.forEach(el => {
        appearOnScroll.observe(el);
    });

    // --- Set Current Year dynamically in footer ---
    document.getElementById('year').textContent = new Date().getFullYear();

    // --- Mobile Menu Toggle placeholder ---
    const mobileBtn = document.querySelector('.mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');

    mobileBtn.addEventListener('click', () => {
        // Toggle active class on nav links for mobile (if expanded further)
        // Simplest implementation:
        if (navLinks.style.display === 'flex') {
            navLinks.style.display = 'none';
        } else {
            navLinks.style.display = 'flex';
            navLinks.style.flexDirection = 'column';
            navLinks.style.position = 'absolute';
            navLinks.style.top = '70px';
            navLinks.style.left = '0';
            navLinks.style.width = '100%';
            navLinks.style.background = 'var(--glass-bg)';
            navLinks.style.backdropFilter = 'blur(16px)';
            navLinks.style.padding = '20px';
            navLinks.style.borderBottom = '1px solid var(--glass-border)';
            navLinks.style.gap = '20px';
            navLinks.style.textAlign = 'center';
        }
    });

    // --- Secure Contact Form ---
    const contactForm = document.getElementById('contactForm');
    const submitBtn = contactForm ? contactForm.querySelector('.submit-btn') : null;
    const formStatus = document.getElementById('form-status');
    const turnstileContainer = document.getElementById('turnstile-container');

    if (!contactForm || !submitBtn || !formStatus || !turnstileContainer) {
        return;
    }

    let turnstileWidgetId = null;
    let captchaRequired = false;
    const defaultSubmitMarkup = submitBtn.innerHTML;

    const setFormStatus = (message, type) => {
        formStatus.textContent = message;
        formStatus.classList.remove('success', 'error');
        if (type) {
            formStatus.classList.add(type);
        }
    };

    const waitForTurnstile = () => new Promise((resolve, reject) => {
        let attempts = 0;
        const timer = setInterval(() => {
            attempts += 1;
            if (window.turnstile) {
                clearInterval(timer);
                resolve();
                return;
            }

            if (attempts >= 40) {
                clearInterval(timer);
                reject(new Error('Turnstile script did not load'));
            }
        }, 150);
    });

    const initTurnstile = async () => {
        submitBtn.disabled = true;
        setFormStatus('Loading security check...', '');

        try {
            const configResponse = await fetch('/api/config', {
                headers: { 'Accept': 'application/json' }
            });

            if (!configResponse.ok) {
                throw new Error('Config endpoint failed');
            }

            const config = await configResponse.json();
            if (typeof config.turnstileEnabled !== 'boolean') {
                submitBtn.disabled = true;
                setFormStatus('Backend is outdated. Restart server with "npm run dev", then refresh.', 'error');
                return;
            }

            captchaRequired = Boolean(config.turnstileEnabled);

            if (!captchaRequired) {
                const captchaGroup = turnstileContainer.closest('.captcha-group');
                if (captchaGroup) {
                    captchaGroup.style.display = 'none';
                }
                submitBtn.disabled = false;
                setFormStatus('', '');
                return;
            }

            if (!config.turnstileSiteKey) {
                throw new Error('Missing Turnstile site key');
            }

            await waitForTurnstile();

            turnstileWidgetId = window.turnstile.render(turnstileContainer, {
                sitekey: config.turnstileSiteKey,
                theme: document.body.classList.contains('dark-mode') ? 'dark' : 'light'
            });

            submitBtn.disabled = false;
            setFormStatus('', '');
        } catch (error) {
            console.error('Contact security setup failed:', error);
            submitBtn.disabled = true;
            setFormStatus('Security check failed to load. Start backend with "npm run dev", then refresh.', 'error');
        }
    };

    initTurnstile();

    contactForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        setFormStatus('', '');

        const formData = new FormData(contactForm);
        const payload = {
            name: String(formData.get('name') || ''),
            email: String(formData.get('email') || ''),
            message: String(formData.get('message') || ''),
            company: String(formData.get('company') || ''),
            turnstileToken: String(formData.get('cf-turnstile-response') || '')
        };

        if (captchaRequired && !payload.turnstileToken) {
            setFormStatus('Please complete the security check before sending.', 'error');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Sending... <i class="fas fa-spinner fa-spin"></i>';

        try {
            const response = await fetch('/api/contact', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            let result = {};
            try {
                result = await response.json();
            } catch (parseError) {
                result = {};
            }

            if (!response.ok || !result.ok) {
                throw new Error(result.message || 'Unable to send message right now.');
            }

            contactForm.reset();
            if (window.turnstile && turnstileWidgetId !== null) {
                window.turnstile.reset(turnstileWidgetId);
            }

            setFormStatus('Message sent successfully. I will get back to you soon.', 'success');
        } catch (error) {
            console.error('Contact submission failed:', error);
            setFormStatus(error && error.message ? error.message : 'Unable to send message right now. Please try again later.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = defaultSubmitMarkup;
        }
    });

});
