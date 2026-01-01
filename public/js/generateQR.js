// public/js/generateQR.js
document.addEventListener('DOMContentLoaded', () => {
  const generateQRForm = document.getElementById('generate-qr-form');
  const qrCodeResult = document.getElementById('qr-code-result');
  const qrCodeImage = document.getElementById('qr-code-image');
  const qrCodeUrlElement = document.getElementById('qr-code-url');
  const qrCodeModal = document.getElementById('qr-code-modal');
  const openQRCodeModalBtn = document.getElementById('open-qr-code-modal');
  const copyUrlBtn = document.getElementById('copy-url-btn');

  // Open the QR Code Modal
  openQRCodeModalBtn.addEventListener('click', () => {
    qrCodeModal.classList.remove('hidden');
    qrCodeModal.classList.add('show');
    // Reset form and result
    generateQRForm.classList.remove('hidden');
    qrCodeResult.classList.add('hidden');
    generateQRForm.reset();
  });

  // Close the modal when clicking outside of the modal content
  window.addEventListener('click', (event) => {
    if (event.target === qrCodeModal) {
      qrCodeModal.classList.add('hidden');
      qrCodeModal.classList.remove('show');
      generateQRForm.reset();
      qrCodeResult.classList.add('hidden');
    }
  });

  // Fetch users to populate the select dropdown
  fetch('/users/list')
    .then(response => response.json())
    .then(users => {
      const userSelect = generateQRForm.elements['userId'];
      userSelect.innerHTML = ''; // Clear existing options
      users.forEach(user => {
        const option = document.createElement('option');
        option.value = user._id;
        option.textContent = user.username;
        userSelect.appendChild(option);
      });
    })
    .catch(err => console.error('Error fetching users:', err));

  generateQRForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(generateQRForm);
    const data = {
      userId: formData.get('userId'),
      quantity: parseInt(formData.get('quantity'), 10),
      reason: formData.get('reason'),
    };

    fetch('/qrcodes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then(response => response.json())
      .then(result => {
        if (result.qrCodeUrl && result.redemptionUrl) {
          qrCodeImage.src = result.qrCodeUrl;
          // Display the redemption URL by setting the 'value' property
          qrCodeUrlElement.value = result.redemptionUrl;
          // Hide the form and show the QR code result
          generateQRForm.classList.add('hidden');
          qrCodeResult.classList.remove('hidden');
        } else {
          alert('Error generating QR code.');
        }
      })
      .catch(err => console.error('Error generating QR code:', err));
  });

  // Copy URL to clipboard
  copyUrlBtn.addEventListener('click', () => {
    qrCodeUrlElement.select();
    qrCodeUrlElement.setSelectionRange(0, 99999); // For mobile devices

    navigator.clipboard.writeText(qrCodeUrlElement.value)
      .then(() => {
        alert('URL copied to clipboard!');
      })
      .catch(err => {
        console.error('Error copying URL:', err);
      });
  });
});